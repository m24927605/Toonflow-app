import { devNull, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "@toonflow/file";
import { findCommand } from "@/utils/cli";
import { resolveEnvReference } from "@/utils/conf/env";
import { checkColabBudget, meterColab, recordColabUnits } from "@/utils/media/usage";
import runtimeSource from "./colabRuntime.py" with { type: "text" };
import preparationSource from "./modelPreparation.py" with { type: "text" };
import pythonDependencies from "./pythonDependencies.json";
import { recordColabTiming } from "./timings";

const runtimeSourceId = createHash("sha256").update(JSON.stringify([runtimeSource, preparationSource, pythonDependencies])).digest("hex");

// Compute units per hour of each machine as Toonflow opens it, the A100 with high RAM (colab usage, 2026-10-15), for a
// session whose own rate the account's cannot show.
export const machineRates = { A100: 6.77, L4: 1.54 };
// How long a refused or unavailable session start keeps retrying.
const allocationWait = 60 * 60_000;
// The Colab CLI uploads through the Jupyter contents API as base64, whose request limit (about 100 MiB) refuses files
// over about 75 MB, such as a rank 16 LoRA, so larger files travel in parts that the job joins before its script runs.
const uploadPart = 48 * 1024 * 1024;
const transferConcurrency = 3;
const inlineOutputLimit = 64 * 1024;
// The CLI sets no timeout on a transfer, and one has hung for 22 minutes until the VM had released itself. An upload is
// given this much, plus a second for every 128 KiB, before it is cut and sent again. ACT: assumes an uplink of at
// least 1 Mbit/s; a slower one needs a measured rate here.
const uploadTimeout = (bytes: number) => 120_000 + bytes / 128;
// Seconds one exec may run. LoRA training on an L4 runs past two hours (clips, slider practice images); a kernel that
// dies sooner is caught by the heartbeat, so this only bounds a job that keeps running.
const execTimeout = 6 * 3600;
// A detached job is checked this often, and fails only after the host has been unable to reach it this long.
const detachedPoll = 60_000;
const offlineGrace = 30 * 60_000;
// How long a failing stop is retried before the session is reported as possibly still billing.
const stopRetry = 60 * 60_000;

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

export type ColabMachine = { gpu: "A100" | "L4"; highMem?: boolean };

/** The job's Python script raised; the kernel is still running and keeps whatever earlier jobs loaded. */
export class ColabScriptError extends Error {
  readonly unsafe: boolean;

  constructor(message: string, options?: ErrorOptions & { unsafe?: boolean }) {
    super(message, options);
    this.unsafe = options?.unsafe ?? false;
  }
}
/** A fresh, idle heartbeat and an execution fence prove that no GPU job remains in flight. */
export class ColabConnectionError extends Error {}

/** The VM was released or reclaimed; this does not establish whether its last job ran. */
export class ColabSessionGoneError extends Error {}


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

// The hourly rate of each session this process has running, which the compute unit meter adds up.
const sessionRates = new Map<string, number>();
/**
 * Machines that started or were running but could not be taken into use, by name with their GPU; they keep running
 * until the user stops the machines, and a lane that needs a machine of that GPU takes one back first.
 */
export const strayColabSessions = new Map<string, ColabMachine["gpu"]>();
// How often the meter is written while sessions run.
const meterTick = 60_000;
let meterTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Meters the running sessions' rates from now on, and while any run, every meterTick. Machines run until the user stops
 * them, so a gap while this host was asleep, offline or killed counts in full.
 */
function meterSessions() {
  try {
    meterColab([...sessionRates.values()].reduce((sum, rate) => sum + rate, 0));
  } catch (error) {
    console.error("[colab] The compute unit meter could not be updated:", error);
  }
  if (sessionRates.size && !meterTimer) {
    meterTimer = setInterval(meterSessions, meterTick);
    meterTimer.unref();
  } else if (!sessionRates.size && meterTimer) {
    clearInterval(meterTimer);
    meterTimer = undefined;
  }
}

// CLI errors quote the VM's proxy URLs, whose token opens the running VM; messages are shown and saved, so it is cut.
const tail = (text: string, length = 3000) => stripVTControlCharacters(text).replace(/(colab-runtime-proxy-token=)[^&\s]+/g, "$1\u2026").trim().slice(-length);

const idempotent = new Set(["upload", "download", "sessions", "usage"]);
// Includes the proxy's 502, 503 and 504, which it answers for a moment while the VM is busy or briefly unreachable.
const transient = /ReadTimeout|ConnectTimeout|ConnectionError|Connection aborted|RemoteDisconnected|Connection was lost|unable to open database file|database is locked|50[234] Server Error/;
// The CLI's answer, on stdout, for a session Colab no longer has: its VM was released or reclaimed.
// Matched by the session's own name: the CLI also reports other, stale sessions it prunes from its local list.
const sessionGone = (name: string) => new RegExp(`Session '${name}' not found`);

async function colab(command: string, args: string[], signal?: AbortSignal, timeout?: number) {
  const session = args.includes("--session") ? args[args.indexOf("--session") + 1] : undefined;
  for (let attempt = 1; ; attempt++) {
    const limit = timeout ? AbortSignal.timeout(timeout) : undefined;
    const attemptSignal = limit && signal ? AbortSignal.any([signal, limit]) : limit ?? signal;
    // `new` runs in its own process group, so a Ctrl-C in the terminal cannot kill it midway (see openColabSession).
    const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal: attemptSignal, detached: args[0] === "new" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    signal?.throwIfAborted();
    if (child.exitCode === 0) return stdout;
    if (limit?.aborted) {
      if (idempotent.has(args[0]!) && attempt < 4) continue;
      throw new Error(`Colab CLI ${args[0]} did not finish within ${Math.round(timeout! / 1000)} s, ${attempt} times`);
    }
    // Parallel jobs share the CLI's local session database, which another CLI process can hold for a moment.
    if (stderr.includes("unable to open database") && attempt < 5) {
      console.log("[colabRetry]", JSON.stringify({ session, operation: args[0], attempt, reason: "sessionDatabase", waitSeconds: attempt * 3 }));
      await scheduler.wait(attempt * 3_000, { signal });
      continue;
    }
    // A dropped connection to the VM fails a whole job for a moment's network trouble; transfers and reads can simply
    // run again, while an exec may already have run and is left to its own recovery.
    if (idempotent.has(args[0]!) && transient.test(stderr) && attempt < 4) {
      console.log("[colabRetry]", JSON.stringify({ session, operation: args[0], attempt, reason: transient.exec(stderr)?.[0], waitSeconds: attempt * 10 }));
      await scheduler.wait(attempt * 10_000, { signal });
      continue;
    }
    if (session && sessionGone(session).test(`${stdout}${stderr}`)) throw new ColabSessionGoneError(tail(`${stdout}\n${stderr}`, 500));
    throw new Error(tail(`${stdout}\n${stderr}`, 2000) || `Colab CLI exited with code ${child.exitCode}`);
  }
}

const heartbeatPath = "/content/.toonflowHeartbeat";

/**
 * Run in a fresh kernel after a reset: a model server started by the old kernel lives on as an orphan and keeps its GPU
 * memory, so every GPU process but NVIDIA's MPS server is killed before the next model loads.
 */
const resetScript = `import os, signal, subprocess, time
def models():
    rows = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid,process_name", "--format=csv,noheader,nounits"], text=True).splitlines()
    return [int(row.split(",")[0]) for row in rows if row.strip() and "nvidia-cuda-mps" not in row]
for pid in models():
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except ProcessLookupError:
        pass
deadline = time.monotonic() + 30
while models():
    if time.monotonic() > deadline:
        raise RuntimeError("GPU processes survived the reset")
    time.sleep(0.5)
print("COLAB_DONE")
`;

/**
 * Started once per session. `colab status` only reports the CLI's local bookkeeping (it shows IDLE before an exec
 * reaches the kernel and BUSY forever after the kernel dies), so the kernel reports itself: a thread rewrites the
 * heartbeat file with the time, the job it runs and the outcome of the last finished job, which an IPython hook
 * records. The file is read through the Jupyter contents API, which works while the kernel is busy.
 */
const heartbeatScript = `import json, os, threading, time
if "toonflowState" not in globals():
    os.makedirs("/content", exist_ok=True)
    toonflowState = {"current": None, "finished": None, "error": None, "active": None}
    toonflowExecutions = {}
    def toonflowFinished(result):
        execId = toonflowState.get("active")
        if execId is None:
            return
        error = None if result.success else repr(result.error_in_exec or result.error_before_exec)
        toonflowExecutions[execId] = error
        toonflowState.update(finished=execId, error=error, active=None)
    get_ipython().events.register("post_run_cell", toonflowFinished)
    def toonflowHeartbeat():
        while True:
            with open("${heartbeatPath}.tmp", "w") as file:
                json.dump({"beat": time.time(), **toonflowState}, file)
            os.replace("${heartbeatPath}.tmp", "${heartbeatPath}")
            time.sleep(15)
    threading.Thread(target=toonflowHeartbeat, daemon=True).start()
print("COLAB_DONE")
`;

const stateLost = "TOONFLOW_KERNEL_STATE_LOST";
/**
 * A hung CLI exec can leave the session on a new kernel while the old one keeps its memory (a loaded model) and its
 * heartbeat, so every job first checks that it runs in the kernel the heartbeat started in.
 */
const stateCheck = `if "toonflowState" not in globals() or "toonflowExecutions" not in globals():\n    raise RuntimeError("${stateLost}")\n`;

const beatSchema = z.object({ beat: z.number(), current: z.string().nullable(), finished: z.string().nullable(), error: z.string().nullable(), active: z.string().nullable() });

/** Why the watcher ended an exec early. */
type ExecLost =
  | { reason: "kernelLost" }
  | { reason: "notStarted" }
  | { reason: "finished"; error: string | null };

// Memory, out-of-memory kills and the ComfyUI log tail, printed after the kernel running a job has died.
const diagnoseScript = `import subprocess
print(subprocess.run("free -g; dmesg 2>/dev/null | grep -i -E 'killed process|out of memory' | tail -5; tail -40 /content/comfyui.log 2>/dev/null", shell=True, capture_output=True, text=True).stdout)
`;

/**
 * `colab exec` can hang without running anything: right after a session starts, its kernel websocket may drop and the
 * CLI raises "Connection was lost" yet never exits. It also never returns when the kernel dies (crash, out of memory),
 * spinning past its own timeout while the GPU bills, or when the connection drops after the job finished. Each
 * reading of the heartbeat tells these apart; retries share a logical ID so a delayed request cannot run work twice.
 */
function watchHeartbeat(command: string, session: string, directory: string, execId: string, controller: AbortController) {
  const local = join(directory, "heartbeat");
  let lastBeat = 0;
  let missed = 0;
  let waiting = 0;
  let reading = false;
  let contactedAt = Date.now();
  const lost = (detail: ExecLost) => controller.abort(detail);
  const timer = setInterval(async () => {
    if (reading) return;
    reading = true;
    const state = await colab(command, ["download", "--session", session, heartbeatPath, local], AbortSignal.timeout(40_000))
      .then(async () => beatSchema.parse(JSON.parse(await readFile(local, "utf8"))))
      .catch(() => undefined)
      .finally(() => { reading = false; });
    if (!state) {
      if (Date.now() - contactedAt > offlineGrace) lost({ reason: "kernelLost" });
      return;
    }
    contactedAt = Date.now();
    const advanced = !!state && state.beat > lastBeat;
    missed = advanced ? 0 : missed + 1;
    lastBeat = state?.beat ?? lastBeat;
    if (missed >= 12) return lost({ reason: "kernelLost" });
    if (!state) return;
    if (state.finished === execId) {
      lost({ reason: "finished", error: state.error });
    } else if (advanced && state.active === null && state.current !== execId && ++waiting >= 3) {
      lost({ reason: "notStarted" });
    } else if (state.active !== null) waiting = 0;
  }, 15_000);
  return () => clearInterval(timer);
}

function checkJob({ uploads, env, outputs }: Omit<ColabJob, "provider">) {
  // Every value below reaches argv, so only plain tokens are accepted; free text travels as uploaded files.
  for (const { name } of uploads) if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid Colab upload file name: ${name}`);
  if (new Set(uploads.map(item => item.name)).size !== uploads.length) throw new Error("Colab upload file names must be unique");
  for (const [name, value] of Object.entries(env)) if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !/^[\w.:-]+$/.test(String(value)) || typeof value === "number" && !Number.isFinite(value)) throw new Error(`Invalid Colab environment variable: ${name}`);
  for (const output of outputs) if (!/^\/content\/[\w./-]+$/.test(output) || output.includes("..")) throw new Error(`Invalid Colab output path: ${output}`);
}

/** The account's compute unit balance as `colab usage` reports it; it lags real use by a few minutes. */
export async function readColabBalance(signal?: AbortSignal) {
  const command = findCommand("colab", "Colab CLI not found. Install google-colab-cli and run `colab sessions` in a terminal to sign in with Google");
  await guardColabLog();
  const balance = Number(/Current balance:\s*([\d.]+)/.exec(await colab(command, ["usage"], signal))?.[1]);
  if (!Number.isFinite(balance)) throw new Error("Could not read the Colab compute unit balance");
  return balance;
}

export type ColabSession = Awaited<ReturnType<typeof openColabSession>>;

/**
 * Opens a Colab session with the user's local Colab CLI login. Jobs run in one kernel, so state from earlier jobs stays
 * loaded; the caller must close() the session. Toonflow never reads or forwards the Colab credentials.
 */
export async function openColabSession(provider: string, { gpu, highMem }: ColabMachine, signal?: AbortSignal, retainedName?: string) {
  await checkColabBudget(provider);
  const command = findCommand("colab", "Colab CLI not found. Install google-colab-cli and run `colab sessions` in a terminal to sign in with Google");
  await guardColabLog();
  const directory = await mkdtemp(join(tmpdir(), "toonflow-colab-"));
  if (retainedName && !/^toonflow-[0-9a-f]{8}$/.test(retainedName)) throw new Error("Invalid retained Colab session name");
  const name = retainedName ?? `toonflow-${crypto.randomUUID().slice(0, 8)}`;
  // The user's Hugging Face token (HF_TOKEN in the environment or ~/.env), which the weight downloads send to the Hub so
  // many machines starting at once are not throttled. It reaches the VM only as an uploaded file that the scripts read
  // and pass to Hugging Face alone: `colab exec --env` writes its values into the code the CLI records in its history.
  const hubToken = await resolveEnvReference("env:HF_TOKEN").then(value => typeof value === "string" && /^hf_\w+$/.test(value.trim()) ? value.trim() : undefined, () => undefined);
  let startedAt = 0;
  let hourlyRate = machineRates[gpu];
  let files = 0;
  let stopped = false;
  let billedAt = 0;
  let runtimeUploaded = false;
  const inputCache = new Map<string, number>();

  async function attribute(next: string) {
    await checkColabBudget(next);
    if (next === provider) return;
    const now = Date.now();
    if (billedAt) await recordColabUnits(provider, (now - billedAt) / 3_600_000 * hourlyRate);
    provider = next;
    billedAt = now;
  }

  async function keepAlive(signal?: AbortSignal) {
    await exec("print('COLAB_DONE')\n", {}, signal);
  }

  /** Restarts the kernel, dropping every loaded model, and keeps the machine, so the next job starts clean. */
  async function reset(signal?: AbortSignal) {
    await colab(command, ["restart-kernel", "--session", name], signal);
    const path = join(directory, `reset${files++}.py`);
    await writeFile(path, resetScript);
    const output = await colab(command, ["exec", "--session", name, "--timeout", "120", "--file", path], signal, 180_000);
    if (!output.includes("COLAB_DONE")) throw new Error(`The reset of ${name} could not clear its GPU: ${tail(output, 1000)}`);
    await startHeartbeat(signal);
  }

  async function spawnExec(path: string, env: ColabJob["env"], signal: AbortSignal) {
    const child = Bun.spawn([
      command, "exec", "--session", name, "--timeout", String(execTimeout),
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--file", path,
    ], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    // A killed CLI can leave a descendant holding the pipes open, so the output is only awaited briefly after exit.
    const [stdout, stderr] = await Promise.race([output, Bun.sleep(5_000).then(() => ["", "(output unavailable)"])]);
    return { stdout, stderr, exitCode: child.exitCode };
  }

  function checkOutput({ stdout, stderr, exitCode }: Awaited<ReturnType<typeof spawnExec>>) {
    if (exitCode !== 0) throw new Error(tail(`${stdout}\n${stderr}`, 2000) || `Colab CLI exited with code ${exitCode}`);
    if (stderr.includes(stateLost)) throw new Error(`The Colab CLI switched session ${name} to a new kernel, which lost everything loaded so far`);
    // `colab exec` exits with 0 when the script raises and prints the traceback on stderr.
    if (!stdout.includes("COLAB_DONE")) throw new ColabScriptError(`Colab job failed: ${tail(stderr || stdout, 2000)}`);
    for (const line of stdout.split("\n").filter(line => line.startsWith("COLAB_MODEL "))) {
      const measured = z.strictObject({ model: z.string(), switched: z.boolean(), seconds: z.number().finite().nonnegative() }).parse(JSON.parse(line.slice("COLAB_MODEL ".length)));
      console.log("[colabModelTiming]", JSON.stringify({ session: name, ...measured }));
    }
    return stdout;
  }

  /**
   * Starts the heartbeat. The first execs of a new session may hang before reaching the kernel or time out while the
   * machine's proxy comes up, so it is retried; the script starts nothing twice.
   */
  async function startHeartbeat(signal?: AbortSignal) {
    if (hubToken) {
      const local = join(directory, "hubToken");
      await writeFile(local, hubToken, { mode: 0o600 });
      await colab(command, ["upload", "--session", name, local, "/content/.toonflowHubToken"], signal).finally(() => rm(local, { force: true }));
    }
    const path = join(directory, "heartbeat.py");
    await writeFile(path, heartbeatScript);
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(90_000);
      const result = await spawnExec(path, {}, signal ? AbortSignal.any([signal, timeout]) : timeout);
      signal?.throwIfAborted();
      if (!timeout.aborted && !(result.exitCode !== 0 && transient.test(result.stderr))) return checkOutput(result);
      if (attempt === 3) throw new Error(`Colab session ${name} did not run code after three attempts: ${tail(result.stderr, 1000)}`);
      await scheduler.wait(attempt * 10_000, { signal });
    }
  }

  async function exec(script: string, env: ColabJob["env"], signal?: AbortSignal) {
    const execId = `${name}-${crypto.randomUUID()}`;
    for (let attempt = 1; ; attempt++) {
      const path = join(directory, `script${files++}.py`);
      await writeFile(path, `${stateCheck}if "${execId}" in toonflowExecutions:
    toonflowState.update(current="${execId}", finished="${execId}", error=toonflowExecutions["${execId}"])
    if toonflowExecutions["${execId}"] is not None:
        raise RuntimeError(toonflowExecutions["${execId}"])
    print("COLAB_REUSED_EXEC", "${execId}")
    print("COLAB_DONE")
else:
    toonflowState.update(current="${execId}", finished=None, error=None, active="${execId}")
    if __import__("os").path.exists("/content/toonflowExecCancelled${execId}"):
        raise RuntimeError("Execution cancelled before dispatch")
    exec(compile(__import__("base64").b64decode(${JSON.stringify(Buffer.from(script).toString("base64"))}), "${execId}", "exec"), globals())
`);
      const watcher = new AbortController();
      const stopWatching = watchHeartbeat(command, name, directory, execId, watcher);
      const result = await spawnExec(path, env, signal ? AbortSignal.any([signal, watcher.signal]) : watcher.signal).finally(stopWatching);
      signal?.throwIfAborted();
      let lost = watcher.signal.reason as ExecLost;
      if (!watcher.signal.aborted) {
        if (result.exitCode !== 0 && sessionGone(name).test(`${result.stdout}${result.stderr}`)) throw new ColabSessionGoneError(`Colab session ${name} lost its VM`);
        if (result.stderr.includes(stateLost)) return checkOutput(result);
        if (result.exitCode === 0 && result.stdout.includes("COLAB_DONE")) return checkOutput(result);
        // The CLI lost its connection to the VM mid-exec, which tells nothing of the job: the kernel's heartbeat says
        // whether it never started, is still running (followed until it ends) or finished.
        lost = await followExec(execId, signal);
      }
      // The same guarded ID also covers an original request that reaches the kernel after this retry is sent.
      if (lost.reason === "notStarted" && attempt < 3) {
        console.log("[colabRetry]", JSON.stringify({ session: name, execId, attempt, reason: lost.reason }));
        continue;
      }
      if (lost.reason === "notStarted") {
        const cancelled = join(directory, `cancelExec${files++}`);
        await writeFile(cancelled, "");
        await colab(command, ["upload", "--session", name, cancelled, `/content/toonflowExecCancelled${execId}`], AbortSignal.timeout(40_000));
        lost = await followExec(execId, signal);
        if (lost.reason === "notStarted") throw new ColabConnectionError(`Colab could not start the job on session ${name}; the fenced, idle VM was retained for reconnection: ${tail(result.stderr, 1000)}`);
      }
      // The kernel finished but the CLI lost its connection, so the outcome comes from the kernel's own report.
      if (lost.reason === "finished") {
        if (lost.error) throw new ColabScriptError(`Colab job failed: ${lost.error}`, { unsafe: /^RuntimeError\(['"]TOONFLOW_MODEL_UNSAFE:/.test(lost.error) });
        return result.stdout;
      }
      // The VM outlives its kernel, so read why it died before the session is stopped; the exec output so far is kept.
      const report = join(directory, "diagnose.py");
      await writeFile(report, diagnoseScript);
      const details = await colab(command, ["exec", "--session", name, "--timeout", "60", "--file", report], AbortSignal.timeout(90_000)).catch(() => "");
      throw new Error(`Could not establish a safe Colab kernel state for session ${name}; the cause is unconfirmed\n${tail(details)}\nLast job output:\n${tail(`${result.stdout}\n${result.stderr}`)}`);
    }
  }

  async function followExec(execId: string, signal?: AbortSignal): Promise<ExecLost> {
    signal?.throwIfAborted();
    const follow = new AbortController();
    const stopFollowing = watchHeartbeat(command, name, directory, execId, follow);
    const interrupted = () => follow.abort(signal!.reason);
    signal?.addEventListener("abort", interrupted, { once: true });
    try {
      await new Promise(resolve => follow.signal.addEventListener("abort", resolve, { once: true }));
      signal?.throwIfAborted();
      return follow.signal.reason as ExecLost;
    } finally {
      stopFollowing();
      signal?.removeEventListener("abort", interrupted);
    }
  }

  /**
   * Runs a plain Python script (no IPython syntax) as a background process on the VM and checks on it with short
   * execs, so a job of hours, such as LoRA training, survives the host losing its network for a while.
   */
  async function runDetached(prelude: string, script: string, env: ColabJob["env"], signal?: AbortSignal) {
    // A random name: the counter restarts with the server, and a new job then read the exit file of an old one.
    const id = `toonflowJob${crypto.randomUUID().replaceAll("-", "")}`;
    const local = join(directory, `upload${files++}`);
    await writeFile(local, script);
    await colab(command, ["upload", "--session", name, local, `/content/${id}.py`], signal);
    // The shell writes the exit status once the script ends; the kernel only starts it and returns.
    await exec(`${prelude}import subprocess as _toonflowProcess, sys as _toonflowSys
_toonflowProcess.Popen(["/bin/sh", "-c", f"{_toonflowSys.executable} -u /content/${id}.py > /content/${id}.log 2>&1; echo $? > /content/${id}.exit"], cwd="/content", start_new_session=True)
print("COLAB_DONE")
`, env, signal);
    const check = `import os as _toonflowOs
if _toonflowOs.path.exists("/content/${id}.exit"):
    _toonflowLog = open("/content/${id}.log", "rb").read()
    print("TOONFLOW_EXIT", open("/content/${id}.exit").read().strip(), "TOONFLOW_SCRIPT_DONE" if b"COLAB_DONE" in _toonflowLog else "TOONFLOW_SCRIPT_FAILED")
    print(_toonflowLog[-4000:].decode("utf-8", "replace"))
print("COLAB_DONE")
`;
    for (let contact = Date.now(); ; ) {
      await scheduler.wait(detachedPoll, { signal });
      let output: string;
      try {
        output = await exec(check, {}, signal);
        contact = Date.now();
      } catch (error) {
        signal?.throwIfAborted();
        if (Date.now() - contact > offlineGrace) throw new Error(`Lost contact with Colab session ${name} for ${offlineGrace / 60_000} minutes`, { cause: error });
        continue;
      }
      const state = /TOONFLOW_EXIT (\S+) (TOONFLOW_SCRIPT_\w+)/.exec(output);
      if (!state) continue;
      if (state[1] !== "0" || state[2] !== "TOONFLOW_SCRIPT_DONE") throw new ColabScriptError(`Colab job failed (exit ${state[1]}): ${tail(output, 2000)}`, { unsafe: /^RuntimeError: TOONFLOW_MODEL_UNSAFE:/m.test(output) });
      return;
    }
  }

  /**
   * Uploads the inputs, runs the script and downloads the outputs. A detached job runs as a background process that
   * the host checks on, for jobs that run longer than a network connection can be trusted to last.
   */
  type SessionJob = Omit<ColabJob, "provider"> & {
    runtime?: string;
    detached?: boolean;
    /** Streaming callers own fresh output paths and publish each complete file atomically. */
    onOutput?: (index: number, data: Uint8Array) => void;
  };

  async function readOutput(remote: string, signal?: AbortSignal) {
    if (!remote.startsWith("/content/") || remote.split("/").includes("..")) throw new Error("Remote output must stay inside /content");
    const local = join(directory, `output${files++}`);
    await colab(command, ["download", "--session", name, remote, local], signal);
    return new Uint8Array(await readFile(local));
  }

  async function writeInput(remote: string, data: string | Uint8Array, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_.-]+$/.test(remote)) throw new Error("Remote input needs a plain file name");
    const local = join(directory, `upload${files++}`);
    await writeFile(local, data);
    await colab(command, ["upload", "--session", name, local, `/content/${remote}`], signal);
  }

  async function job(request: SessionJob, signal?: AbortSignal) {
    const execution = { id: crypto.randomUUID(), submitted: false };
    try {
      return await executeJob(request, execution, signal);
    } catch (error) {
      if (error instanceof ColabScriptError && /TOONFLOW_INPUT_CACHE_MISS:[a-f0-9]{64}/.test(error.message)) {
        inputCache.clear();
        execution.submitted = false;
        try { return await executeJob(request, execution, signal); }
        catch (retryError) { error = retryError; }
      }
      if (!signal?.aborted || !request.runtime) throw error;
      if (!execution.submitted) throw new ColabScriptError("Model job cancelled before submission", { cause: error });
      const local = join(directory, `cancel${execution.id}`);
      await writeFile(local, "");
      await colab(command, ["upload", "--session", name, local, `/content/toonflowCancel${execution.id}`], AbortSignal.timeout(40_000));
      for (const deadline = Date.now() + 45_000; Date.now() < deadline;) {
        const acknowledged = await colab(command, ["download", "--session", name, `/content/toonflowSettled${execution.id}.json`, local], AbortSignal.timeout(15_000))
          .then(async () => JSON.parse(await readFile(local, "utf8")).settled === true, () => false);
        if (acknowledged) throw new ColabScriptError("Model job cancelled; the VM and installed models were retained", { cause: error });
        await scheduler.wait(2_000);
      }
      throw new Error("Could not confirm that the cancelled model released the GPU", { cause: error });
    }
  }

  async function executeJob({ script, uploads, env, outputs, detached = false, onOutput, runtime }: SessionJob, executionState: { id: string; submitted: boolean }, signal?: AbortSignal) {
    checkJob({ script, uploads, env, outputs });
    if (runtime) {
      if (detached) await exec("if 'toonflowRuntime' in globals():\n    toonflowRuntime.stopModel()\nprint('COLAB_DONE')\n", {}, signal);
      if (!runtimeUploaded) {
        const local = join(directory, "runtime.py");
        const files = [["modelPreparation.py", preparationSource], ["pythonDependencies.json", JSON.stringify(pythonDependencies)]].map(([name, source]) => [name, Buffer.from(source!).toString("base64")]);
        await writeFile(local, `import base64\nfrom pathlib import Path\nfor name, data in ${JSON.stringify(files)}:\n    path = Path('/content') / name\n    temporary = path.with_suffix('.bootstrap')\n    temporary.write_bytes(base64.b64decode(data))\n    temporary.replace(path)\n${runtimeSource}`);
        await colab(command, ["upload", "--session", name, local, "/content/toonflowRuntime.py"], signal);
        runtimeUploaded = true;
      }
      const source = Buffer.from(script).toString("base64");
      const call = `toonflowRuntime.runModel(${JSON.stringify(runtime)}, ${JSON.stringify(source)}, ${JSON.stringify(env)}, ${JSON.stringify(executionState.id)})`;
      script = `import importlib.util as _toonflowImport\nif globals().get("toonflowRuntimeSourceId") != ${JSON.stringify(runtimeSourceId)}:\n    if "toonflowRuntime" in globals():\n        toonflowRuntime.stopModel()\n    _spec = _toonflowImport.spec_from_file_location("toonflowRuntime", "/content/toonflowRuntime.py")\n    toonflowRuntime = _toonflowImport.module_from_spec(_spec)\n    _spec.loader.exec_module(toonflowRuntime)\n    toonflowRuntimeSourceId = ${JSON.stringify(runtimeSourceId)}\n${detached ? `try:\n    ${call}\nfinally:\n    toonflowRuntime.stopModel()\n` : `${call}\n`}`;
    }
    const jobStarted = performance.now();
    let wireUploads = uploads;
    let inputSetup = "";
    const remembered: { hash: string; bytes: number }[] = [];
    const totalBytes = uploads.reduce((sum, item) => sum + (typeof item.data === "string" ? Buffer.byteLength(item.data) : item.data.length), 0);
    // Keep bundles small; large LoRAs retain the existing bounded multipart transport.
    if (uploads.length > 1 && totalBytes <= uploadPart) {
      const bindings = uploads.map(item => {
        const data = typeof item.data === "string" ? Buffer.from(item.data) : item.data;
        return { name: item.name, data, hash: createHash("sha256").update(data).digest("hex"), bytes: data.length };
      });
      const used = new Set(bindings.map(item => item.hash));
      const additions = [...new Map(bindings.map(item => [item.hash, item])).values()].filter(item => !inputCache.has(item.hash));
      let size = [...inputCache.values()].reduce((sum, bytes) => sum + bytes, 0) + additions.reduce((sum, item) => sum + item.bytes, 0);
      for (const [hash, bytes] of inputCache) {
        if (size <= 1024 ** 3) break;
        if (used.has(hash)) continue;
        inputCache.delete(hash);
        size -= bytes;
      }
      const archiveName = `toonflowInputs${executionState.id}.zip`;
      wireUploads = additions.length ? [{ name: archiveName, data: zipSync(Object.fromEntries(additions.map(item => [item.hash, item.data])), { level: 0 }) }] : [];
      remembered.push(...bindings.map(({ hash, bytes }) => ({ hash, bytes })));
      inputSetup = `import hashlib as _inputHash, json as _inputJson, os as _inputOs, shutil as _inputShutil, zipfile as _inputZip
from pathlib import Path as _inputPath
_inputRoot = _inputPath('/content/toonflowInputs')
_inputRoot.mkdir(exist_ok=True)
_inputKeep = set(${JSON.stringify([...new Set([...inputCache.keys(), ...used])])})
for _old in _inputRoot.iterdir():
    _name = _old.name.removesuffix('.partial')
    if len(_name) == 64 and all(_char in '0123456789abcdef' for _char in _name) and (_name not in _inputKeep or _old.name.endswith('.partial')):
        _old.unlink()
${additions.length ? `with _inputZip.ZipFile('/content/${archiveName}') as _bundle:
    for _hash in _bundle.namelist():
        if len(_hash) != 64 or any(_char not in '0123456789abcdef' for _char in _hash):
            raise ValueError('Invalid input cache member')
        _data = _bundle.read(_hash)
        if _inputHash.sha256(_data).hexdigest() != _hash:
            raise ValueError('Input bundle digest mismatch')
        _temporary = _inputRoot / (_hash + '.partial')
        _temporary.write_bytes(_data)
        _temporary.replace(_inputRoot / _hash)
_inputPath('/content/${archiveName}').unlink()
` : ""}for _binding in _inputJson.loads(${JSON.stringify(JSON.stringify(bindings.map(({ name, hash, bytes }) => ({ name, hash, bytes }))))}):
    _cached = _inputRoot / _binding['hash']
    if not _cached.is_file() or _cached.stat().st_size != _binding['bytes'] or _inputHash.sha256(_cached.read_bytes()).hexdigest() != _binding['hash']:
        raise RuntimeError('TOONFLOW_INPUT_CACHE_MISS:' + _binding['hash'])
    _temporary = _inputPath('/content') / (_binding['name'] + '.partial')
    _inputShutil.copyfile(_cached, _temporary)
    _temporary.replace(_inputPath('/content') / _binding['name'])
`;
    }
    const rememberInputs = () => { for (const item of remembered) { inputCache.delete(item.hash); inputCache.set(item.hash, item.bytes); } };
    const split: [string, number][] = [];
    const transfers: { remote: string; data: string | Uint8Array }[] = [];
    for (const { name: remote, data } of wireUploads) {
      const parts = typeof data === "string" || data.length <= uploadPart ? [data]
        : Array.from({ length: Math.ceil(data.length / uploadPart) }, (_, index) => data.subarray(index * uploadPart, (index + 1) * uploadPart));
      for (const [index, part] of parts.entries()) {
        transfers.push({ remote: parts.length > 1 ? `${remote}.part${index}` : remote, data: part });
      }
      if (parts.length > 1) split.push([remote, parts.length]);
    }
    for (let index = 0; index < transfers.length; index += transferConcurrency) {
      const results = await Promise.allSettled(transfers.slice(index, index + transferConcurrency).map(async ({ remote, data }) => {
        signal?.throwIfAborted();
        const local = join(directory, `upload${files++}`);
        await writeFile(local, data);
        const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
        await colab(command, ["upload", "--session", name, local, `/content/${remote}`], signal, uploadTimeout(bytes * transferConcurrency))
          .catch((error: unknown) => {
            // /content always exists on a running VM, so its contents API answering "not found" means the VM is gone.
            throw /File or directory not found/.test(String(error)) ? new ColabSessionGoneError(`Colab session ${name} lost its VM`, { cause: error }) : error;
          });
      }));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    const uploadedAt = performance.now();
    const timingRole = provider === "colab" ? gpu === "L4" ? "text" : "visualReview" : provider;
    void recordColabTiming({ role: timingRole, phase: "upload", gpu, seconds: (uploadedAt - jobStarted) / 1000, passed: true });
    console.log("[colabInputTransfer]", JSON.stringify({ session: name, files: uploads.length, wireFiles: wireUploads.length, inputBytes: totalBytes, wireBytes: wireUploads.reduce((sum, item) => sum + (typeof item.data === "string" ? Buffer.byteLength(item.data) : item.data.length), 0) }));
    const joinParts = (split.length ? `import os as _toonflowOs
for _name, _count in ${JSON.stringify(split)}:
    with open(f"/content/{_name}", "wb") as _whole:
        for _index in range(_count):
            with open(f"/content/{_name}.part{_index}", "rb") as _part:
                _whole.write(_part.read())
            _toonflowOs.remove(f"/content/{_name}.part{_index}")
` : "") + inputSetup;
    const download = readOutput;
    if (onOutput) {
      const controller = new AbortController();
      const jobSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let finished = false;
      let failed = false;
      let failure: unknown;
      executionState.submitted = true;
      const execution = (detached ? runDetached(joinParts, script, env, jobSignal) : exec(joinParts + script, env, jobSignal))
        .then(rememberInputs)
        .catch((error: unknown) => { failed = true; failure = error; }).finally(() => { finished = true; });
      const results: Uint8Array[] = [];
      try {
        for (const [index, remote] of outputs.entries()) {
          for (;;) {
            jobSignal.throwIfAborted();
            if (failed) throw failure;
            let data: Uint8Array;
            try {
              data = await download(remote, jobSignal);
            } catch (error) {
              if (failed) throw failure;
              if (!/File or directory not found/.test(String(error))) throw error;
              if (finished) {
                // The failed read may predate the final file publication; observe the completed state once more.
                data = await download(remote, jobSignal).catch(error => {
                  if (/File or directory not found/.test(String(error))) throw new ColabScriptError(`Completed job did not publish ${remote}`, { cause: error });
                  throw error;
                });
                results.push(data);
                onOutput(index, data);
                break;
              }
              await scheduler.wait(2_000, { signal: jobSignal });
              continue;
            }
            results.push(data);
            onOutput(index, data);
            break;
          }
        }
        await execution;
        if (failed) throw failure;
        return results;
      } finally {
        controller.abort();
        await execution;
        console.log("[colabTiming]", JSON.stringify({ provider, session: name, mode: "streaming", uploadSeconds: (uploadedAt - jobStarted) / 1000, executionAndDownloadSeconds: (performance.now() - uploadedAt) / 1000 }));
      }
    }
    executionState.submitted = true;
    const inlineMarker = `TOONFLOW_OUTPUT ${executionState.id} `;
    const inlineEnd = ` TOONFLOW_OUTPUT_END ${executionState.id}`;
    // Keep small results on the established execution connection; retain files for interrupted replies.
    const collectOutputs = !detached && outputs.length ? `
exec(${JSON.stringify(`import base64, hashlib, json
from pathlib import Path
paths = [Path(path) for path in ${JSON.stringify(outputs)}]
if all(path.resolve().is_relative_to('/content') and path.is_file() for path in paths) and sum(path.stat().st_size for path in paths) <= ${inlineOutputLimit}:
    collected = []
    remaining = ${inlineOutputLimit}
    for path in paths:
        with path.open('rb') as source:
            data = source.read(remaining + 1)
        remaining -= len(data)
        if remaining < 0:
            break
        collected.append({'data': base64.b64encode(data).decode('ascii'), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    if len(collected) == len(paths):
        print(${JSON.stringify(inlineMarker)} + json.dumps(collected) + ${JSON.stringify(inlineEnd)}, flush=True)
`)}, {})
` : "";
    let reply = "";
    if (detached) await runDetached(joinParts, script, env, signal);
    else reply = await exec(joinParts + script + collectOutputs, env, signal);
    rememberInputs();
    const executedAt = performance.now();
    const inlineLine = reply.split("\n").findLast(line => line.startsWith(inlineMarker) && line.endsWith(inlineEnd));
    const inlineResults = inlineLine ? z.array(z.strictObject({
      data: z.string().max(Math.ceil(inlineOutputLimit / 3) * 4),
      bytes: z.number().int().min(0).max(inlineOutputLimit),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })).length(outputs.length).refine(items => items.reduce((sum, item) => sum + item.bytes, 0) <= inlineOutputLimit).parse(JSON.parse(inlineLine.slice(inlineMarker.length, -inlineEnd.length))).map(item => {
      const data = Buffer.from(item.data, "base64");
      if (data.toString("base64") !== item.data || data.length !== item.bytes || createHash("sha256").update(data).digest("hex") !== item.sha256) {
        throw new Error("Colab execution output failed byte integrity validation");
      }
      return data;
    }) : undefined;
    const results: Uint8Array[] = [];
    if (inlineResults) results.push(...inlineResults);
    for (let index = 0; !inlineResults && index < outputs.length; index += transferConcurrency) {
      const downloaded = await Promise.allSettled(outputs.slice(index, index + transferConcurrency).map(async remote => {
        signal?.throwIfAborted();
        return download(remote, signal);
      }));
      for (const result of downloaded) {
        if (result.status === "rejected") throw result.reason;
        results.push(result.value);
      }
    }
    console.log("[colabTiming]", JSON.stringify({ provider, session: name, mode: detached ? "detached" : "batch", outputTransport: inlineResults ? "executionReply" : outputs.length ? "fileDownload" : "none", outputBytes: results.reduce((sum, item) => sum + item.byteLength, 0), uploadSeconds: (uploadedAt - jobStarted) / 1000, executionSeconds: (executedAt - uploadedAt) / 1000, downloadSeconds: (performance.now() - executedAt) / 1000 }));
    void recordColabTiming({ role: timingRole, phase: "output", gpu, seconds: (performance.now() - executedAt) / 1000, passed: true });
    return results;
  }

  /**
   * Stops the session and records its compute units. A failed stop keeps the GPU billing, so it is never swallowed:
   * it throws with `failure` (the error that led to closing) as its cause, and close() may be called again to retry.
   */
  async function close(failure?: unknown) {
    if (stopped) return;
    // A running session keeps billing, so a stop that fails, such as while the host is offline, is retried until it
    // goes through. ACT: A session that failed to start may not exist, so stop errors only count once `new` succeeded.
    for (const firstTry = Date.now(); ; ) {
      if (await colab(command, ["stop", "--session", name]).then(() => true, () => !startedAt)) break;
      const reason = failure instanceof Error ? ` (it was stopping after: ${failure.message.slice(0, 500)})` : "";
      if (Date.now() - firstTry > stopRetry) {
        throw new Error(`Colab session ${name} could not be stopped; run colab stop --session ${name} so it stops billing${reason}`, { cause: failure });
      }
      await scheduler.wait(30_000);
    }
    stopped = true;
    sessionRates.delete(name);
    meterSessions();
    if (billedAt) await recordColabUnits(provider, (Date.now() - billedAt) / 3_600_000 * hourlyRate);
    await rm(directory, { recursive: true, force: true });
  }

  /** Colab already took the VM back: records its compute units and lets the session go without a stop. */
  async function forget() {
    if (stopped) return;
    stopped = true;
    sessionRates.delete(name);
    meterSessions();
    if (billedAt) await recordColabUnits(provider, (Date.now() - billedAt) / 3_600_000 * hourlyRate);
    await rm(directory, { recursive: true, force: true });
  }

  try {
    // Toonflow sets no machine count of its own: Colab decides. It refuses a new session while the account's sessions
    // are taken and answers 503 while it is short of machines, so such a start waits and retries instead of failing a
    // job that may follow paid steps. A 503 may still have assigned a machine, so it is stopped before the next try.
    // Honor the planned hardware without probing an unrequested accelerator first.
    let assigned: ColabMachine["gpu"] | undefined = retainedName ? gpu : undefined;
    for (const waitStart = Date.now(); !assigned; ) {
      try {
        // A submitted allocation must settle before cancellation can safely release its VM.
        await colab(command, ["new", "--session", name, "--gpu", gpu, ...highMem ? ["--high-mem"] : []]);
        assigned = gpu;
      } catch (error) {
        if (!/Allocation refused|Service Unavailable/.test(String(error))) throw error;
        console.warn(`[colab] ${gpu} start for ${provider} refused (${ /Allocation refused/.test(String(error)) ? "allocation refused" : "service unavailable"})`);
        await colab(command, ["stop", "--session", name]).catch(() => undefined);
        if (Date.now() - waitStart > allocationWait) throw error;
        await scheduler.wait(60_000, { signal });
      }
    }
    startedAt = Date.now();
    billedAt = startedAt;
    signal?.throwIfAborted();
    hourlyRate = machineRates[assigned];
    if (assigned !== gpu) console.log(`[colab] ${provider} runs on an ${assigned}`);
    // Account-wide rate differences cannot identify one VM's rate when machines start in parallel.
    // Meter by the assigned hardware's estimated rate; the account balance remains a separate live reading.
    sessionRates.set(name, hourlyRate);
    meterSessions();
    await startHeartbeat(signal);
    if (retainedName) await keepAlive(signal);
  } catch (error) {
    if (retainedName) throw error;
    // Only the user stops machines: one that started is left running and stopped with the others.
    if (!startedAt) await close(error);
    else {
      strayColabSessions.set(name, gpu);
      await rm(directory, { recursive: true, force: true });
      throw new Error(`${error instanceof Error ? error.message : error}; machine ${name} was left running until the machines are stopped`, { cause: error });
    }
    throw error;
  }
  return { name, job, readOutput, writeInput, close, forget, reset, attribute, keepAlive };
}

/**
 * Ends this computer's Colab CLI calls still attached to a machine, such as those of a server process that was killed:
 * they keep the kernel busy and made a restarted server fail to take the machine back.
 * ACT: matched by the session name in their command line, so it assumes one Toonflow server per computer.
 */
export async function endLocalColabCalls(name: string) {
  if (!/^toonflow-[0-9a-f]{8}$/.test(name)) throw new Error("Invalid Colab session name");
  await Bun.spawn(["pkill", "-f", "--", `--session ${name}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
}

/** Stops a Toonflow machine this process holds no session for, such as one left over from before a restart. */
export async function stopColabSession(name: string) {
  if (!/^toonflow-[0-9a-f]{8}$/.test(name)) throw new Error("Invalid Colab session name");
  await colab(findCommand("colab", "Colab CLI not found"), ["stop", "--session", name]);
  strayColabSessions.delete(name);
  sessionRates.delete(name);
  meterSessions();
}

/** Read a Toonflow kernel heartbeat without executing code or owning the VM. */
export async function readColabSessionStatus(name: string) {
  if (!/^toonflow-[0-9a-f]{8}$/.test(name)) throw new Error("Invalid Colab session name");
  let directory: string | undefined;
  const checkedAt = new Date().toISOString();
  try {
    const command = findCommand("colab", "Colab CLI not found");
    await guardColabLog();
    directory = await mkdtemp(join(tmpdir(), "toonflowStatus"));
    const local = join(directory, "heartbeat.json");
    // A slow Colab CLI took more than 8 s at times and dropped healthy machines from the pool after a restart.
    await colab(command, ["download", "--session", name, heartbeatPath, local], AbortSignal.timeout(30_000));
    const beat = beatSchema.parse(JSON.parse(await readFile(local, "utf8")));
    // The machine answered but its heartbeat stopped, as after its kernel was restarted or died: it is there, its state is not.
    if (Math.abs(Date.now() - beat.beat * 1000) > 90_000) return { state: "unknown" as const, stale: true, checkedAt };
    return { state: beat.active !== null || beat.current !== beat.finished ? "working" as const : "idle" as const, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { state: error instanceof ColabSessionGoneError ? "off" as const : "unknown" as const, checkedAt };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
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
