import { devNull, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "@toonflow/file";
import { findCommand } from "@/utils/cli";
import { checkColabBudget, recordColabUnits } from "@/utils/media/usage";

// Compute units per hour of a high-RAM A100 (colab usage, 2026-10-11), used when the live rate cannot be read.
const fallbackHourlyRate = 6.77;

export type ColabJob = {
  /** Media provider the session is billed to, for the daily compute unit cap. */
  provider: string;
  /** Python source executed on the session; it must print COLAB_DONE once every output is written. */
  script: string;
  /** Files written to /content/<name> before the script runs. */
  uploads: { name: string; data: string | Uint8Array }[];
  /** Plain-token environment variables for the script. */
  env: Record<string, string | number>;
  /** Absolute remote paths downloaded after the script succeeds, in order. */
  outputs: string[];
};

/**
 * The Colab CLI always writes a DEBUG log to ~/.config/colab-cli/colab.log, which records the Google OAuth tokens in
 * plain text and cannot be relocated, so the log must point at the null device before any command runs.
 */
async function guardColabLog() {
  const directory = join(homedir(), ".config", "colab-cli");
  const log = join(directory, "colab.log");
  const info = await lstat(log).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isSymbolicLink() && await readlink(log) === devNull) return;
  if (info) throw Object.assign(new Error(`The Colab CLI log ${log} records Google sign-in tokens in plain text; delete it and try again`), { status: 400 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await symlink(devNull, log);
}

// Sessions this process opened and has not stopped yet, with the CLI path that opened them.
const activeSessions = new Map<string, string>();
let exitGuarded = false;

/**
 * A killed or restarted server never reaches the `finally` that stops its session, and an orphaned A100 keeps billing,
 * so every open session is stopped synchronously when the process is told to end.
 */
function guardProcessExit() {
  if (exitGuarded) return;
  exitGuarded = true;
  const stopAll = () => {
    for (const [session, command] of activeSessions) Bun.spawnSync([command, "stop", "--session", session], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    activeSessions.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      stopAll();
      // Without another listener the signal would no longer end the process, so restore the default and re-raise it.
      if (process.listenerCount(signal) > 1) return;
      process.off(signal, handler);
      process.kill(process.pid, signal);
    };
    process.prependListener(signal, handler);
  }
  // The dev watch restart runs SIGUSR1 handlers before restarting (docs/development.md).
  process.prependListener("SIGUSR1", stopAll);
  process.once("exit", stopAll);
}

/**
 * Stops every Toonflow session left on the signed-in Colab account, such as one orphaned when a server was killed
 * outright (SIGKILL, crash, power loss), where no exit handler runs. Called once when the server starts.
 */
export async function stopOrphanedColabSessions() {
  let command: string;
  try {
    command = findCommand("colab", "");
  } catch {
    return [];
  }
  await guardColabLog();
  const listing = await colab(command, ["sessions"]);
  // ACT: Assumes one Toonflow server per Colab account (servers are single-process); a second server signed in to
  // the same account would have its running session stopped here. Tag sessions with a server ID if that is ever needed.
  const orphans = [...new Set(listing.match(/\btoonflow-[0-9a-f]{8}\b/g) ?? [])].filter(session => !activeSessions.has(session));
  for (const session of orphans) await colab(command, ["stop", "--session", session]);
  return orphans;
}

async function colab(command: string, args: string[], signal?: AbortSignal) {
  const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  signal?.throwIfAborted();
  if (child.exitCode !== 0) throw new Error((stderr.trim() || stdout.trim()).slice(-2000) || `Colab CLI exited with code ${child.exitCode}`);
  return stdout;
}

// Memory, out-of-memory kills and the ComfyUI log tail, printed after the kernel running a job has died.
const diagnoseScript = `import subprocess
print(subprocess.run("free -g; dmesg 2>/dev/null | grep -i -E 'killed process|out of memory' | tail -5; tail -40 /content/comfyui.log 2>/dev/null", shell=True, capture_output=True, text=True).stdout)
`;

/**
 * `colab exec` does not notice when the kernel dies (crash, out of memory) and waits for its whole timeout while the
 * A100 keeps billing. Jupyter reports the kernel BUSY while it runs code, so two IDLE readings in a row during exec
 * mean the job is gone and the exec is aborted.
 */
function watchKernel(command: string, session: string, controller: AbortController) {
  let idleReadings = 0;
  const timer = setInterval(async () => {
    const status = await colab(command, ["status", "--session", session]).catch(() => "");
    idleReadings = /Status:\s*IDLE\b/.test(status) ? idleReadings + 1 : 0;
    if (idleReadings >= 2) controller.abort(new Error(`The Colab kernel stopped running the job (session ${session}); it may have crashed or run out of memory`));
  }, 60_000);
  return () => clearInterval(timer);
}

/**
 * Runs one script on a fresh Colab A100 session with the user's local Colab CLI login and returns the downloaded
 * outputs. The session is always stopped. Toonflow never reads or forwards the Colab credentials.
 */
export async function runColabJob({ provider, script, uploads, env, outputs }: ColabJob, signal?: AbortSignal) {
  // Every value below reaches argv, so only plain tokens are accepted; free text travels as uploaded files.
  for (const { name } of uploads) if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid Colab upload file name: ${name}`);
  for (const [name, value] of Object.entries(env)) if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !/^[\w.:-]+$/.test(String(value))) throw new Error(`Invalid Colab environment variable: ${name}`);
  for (const output of outputs) if (!/^\/content\/[\w./-]+$/.test(output) || output.includes("..")) throw new Error(`Invalid Colab output path: ${output}`);
  await checkColabBudget(provider);
  const command = findCommand("colab", "Colab CLI not found. Install google-colab-cli and run `colab sessions` in a terminal to sign in with Google");
  await guardColabLog();
  const directory = await mkdtemp(join(tmpdir(), "toonflow-colab-"));
  const session = `toonflow-${crypto.randomUUID().slice(0, 8)}`;
  let created = false;
  let startedAt = 0;
  let hourlyRate = fallbackHourlyRate;
  let failure: unknown;
  try {
    const scriptPath = join(directory, "job.py");
    await writeFile(scriptPath, script);
    const files: [string, string][] = [];
    for (const [index, { name, data }] of uploads.entries()) {
      const path = join(directory, `upload${index}`);
      await writeFile(path, data);
      files.push([path, `/content/${name}`]);
    }
    guardProcessExit();
    // Tracked before `new` returns, because an interrupted `new` can still leave the session running.
    activeSessions.set(session, command);
    // ACT: The high-RAM shape is required: the Qwen-Image and H3 weights (30+ GB) passed through host memory crashed the
    // standard shape's kernel. It needs Colab Pro or Pro+, which A100 access already implies.
    await colab(command, ["new", "--session", session, "--gpu", "A100", "--high-mem"], signal);
    created = true;
    startedAt = Date.now();
    // ACT: The account-wide rate right after start stands for this session; with parallel sessions it over-counts.
    hourlyRate = Number(/Usage rate:\s*([\d.]+)/.exec(await colab(command, ["usage"]).catch(() => ""))?.[1]) || fallbackHourlyRate;
    for (const [local, remote] of files) await colab(command, ["upload", "--session", session, local, remote], signal);
    const kernelLost = new AbortController();
    const stopWatching = watchKernel(command, session, kernelLost);
    const output = await colab(command, [
      "exec", "--session", session, "--timeout", "7200",
      ...Object.entries(env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
      "--file", scriptPath,
    ], signal ? AbortSignal.any([signal, kernelLost.signal]) : kernelLost.signal).catch(async (error: unknown) => {
      if (!kernelLost.signal.aborted) throw error;
      // The VM outlives its kernel, so read why it died before the session is stopped.
      const report = join(directory, "diagnose.py");
      await writeFile(report, diagnoseScript);
      const details = await colab(command, ["exec", "--session", session, "--timeout", "60", "--file", report]).catch(() => "");
      throw new Error(`${(kernelLost.signal.reason as Error).message}\n${details.trim().slice(-3000)}`);
    }).finally(stopWatching);
    if (!output.includes("COLAB_DONE")) throw new Error(`Colab job failed: ${output.trim().slice(-2000)}`);
    const results: Uint8Array[] = [];
    for (const [index, remote] of outputs.entries()) {
      const local = join(directory, `output${index}`);
      await colab(command, ["download", "--session", session, remote, local], signal);
      results.push(new Uint8Array(await readFile(local)));
    }
    return results;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // ACT: A session that failed to start may not exist, so stop errors are only fatal once `new` succeeded.
    // A failed stop keeps the A100 billing, so it is never swallowed; the original error stays as its cause.
    const stopped = await colab(command, ["stop", "--session", session]).then(() => true, () => !created);
    if (stopped) activeSessions.delete(session);
    if (startedAt) await recordColabUnits(provider, (Date.now() - startedAt) / 3_600_000 * hourlyRate);
    await rm(directory, { recursive: true, force: true });
    if (!stopped) throw new Error(`Colab session ${session} could not be stopped; run colab stop --session ${session} so it stops billing`, { cause: failure });
  }
}

/** A random seed with 53 bits, so it stays exact as a JavaScript number. */
export function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(2)).reduce((high, low) => (high & 0x1fffff) * 2 ** 32 + low);
}

/** Decodes a provider media input into bytes for upload; remote URLs are rejected so nothing is fetched on the host. */
export function inputBytes(input: MediaInput) {
  if (input.type === "url") throw new Error("Colab reference media must be local data; remote URLs are not supported");
  return input.type === "binary" ? input.data : Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64");
}

/** File extension for an uploaded image, limited to plain characters. */
export function inputExtension(input: MediaInput) {
  return input.mimeType?.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png";
}
