import { devNull, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "@toonflow/file";
import { findCommand } from "@/utils/cli";
import { checkColabBudget, recordColabUnits } from "@/utils/media/usage";

// Compute units per hour of a high-RAM A100 (colab usage, 2026-10-11), used when the live rate cannot be read.
// ACT: Smaller GPUs bill less, so the fallback over-counts them; read the rate per machine if that ever matters.
const fallbackHourlyRate = 6.77;
// How long a refused or unavailable session start keeps retrying.
const allocationWait = 60 * 60_000;
// The Colab CLI uploads through the Jupyter contents API as base64, whose request limit (about 100 MiB) refuses files
// over about 75 MB, such as a rank 16 LoRA, so larger files travel in parts that the job joins before its script runs.
const uploadPart = 48 * 1024 * 1024;
// Seconds one exec may run. LoRA training on an L4 runs past two hours (clips, slider practice images); a kernel that
// dies sooner is caught by the heartbeat, so this only bounds a job that keeps running.
const execTimeout = 6 * 3600;
// A detached job is checked this often, and fails only after the host has been unable to reach it this long.
const detachedPoll = 60_000;
const offlineGrace = 30 * 60_000;
// How long a failing stop is retried before the session is reported as possibly still billing.
const stopRetry = 60 * 60_000;
// A VM releases itself after its kernel has been idle this long without the host reaching it; longer than
// offlineGrace, so a host that reconnects in time still stops the session and collects the outputs itself.
const releaseAfter = 45 * 60_000;

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
export class ColabScriptError extends Error {}

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

// Colab gives an account about three GPU sessions at once, at most two of them L4s; a start beyond that waits here for
// one of this process's sessions to stop rather than being refused. ACT: Only this process's sessions count; another
// app on the same account still meets the refusal, which the start retries.
const machineLimits = { total: 3, L4: 2 };
const runningMachines: { gpu: ColabMachine["gpu"] }[] = [];
const machineWaiters = new Set<() => void>();

/** Waits for a free machine of this kind and returns its release. */
async function acquireMachine(gpu: ColabMachine["gpu"], signal?: AbortSignal) {
  const free = () => runningMachines.length < machineLimits.total && (gpu !== "L4" || runningMachines.filter(item => item.gpu === "L4").length < machineLimits.L4);
  while (!free()) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        machineWaiters.delete(wake);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        machineWaiters.delete(wake);
        reject(signal!.reason);
      };
      machineWaiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  const slot = { gpu };
  runningMachines.push(slot);
  return () => {
    const index = runningMachines.indexOf(slot);
    if (index < 0) return;
    runningMachines.splice(index, 1);
    for (const wake of [...machineWaiters]) wake();
  };
}
// Sessions whose `colab new` is still running. That CLI process outlives this one and records the session only once the
// machine is assigned, about a minute later, so until then a stop finds nothing and the machine would bill unseen.
const startingSessions = new Set<string>();
// How long an exit keeps retrying the stop of a starting session: a `new` has taken up to about two minutes.
const startingStopWait = 180_000;
let exitGuarded = false;

/**
 * A killed or restarted server never reaches the `finally` that stops its session, and an orphaned GPU keeps billing,
 * so every open session is stopped synchronously when the process is told to end, waiting for one still starting.
 */
function guardProcessExit() {
  if (exitGuarded) return;
  exitGuarded = true;
  const stopAll = () => {
    for (const [session, command] of activeSessions) {
      const deadline = Date.now() + (startingSessions.has(session) ? startingStopWait : 0);
      for (;;) {
        const { stdout, stderr } = Bun.spawnSync([command, "stop", "--session", session], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        if (!`${stdout}${stderr}`.includes("not found") || Date.now() > deadline) break;
        Bun.sleepSync(3_000);
      }
    }
    activeSessions.clear();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      stopAll();
      // Libraries such as signal-exit only end the process when no foreign listener remains, so this one always steps
      // aside; when it was the only listener, the default is restored and the signal re-raised.
      process.off(signal, handler);
      if (!process.listenerCount(signal)) process.kill(process.pid, signal);
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

const tail = (text: string, length = 3000) => stripVTControlCharacters(text).trim().slice(-length);

const idempotent = new Set(["upload", "download", "sessions", "usage"]);
const transient = /ReadTimeout|ConnectTimeout|ConnectionError|Connection aborted|RemoteDisconnected|Connection was lost/;

async function colab(command: string, args: string[], signal?: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    // `new` runs in its own process group, so a Ctrl-C in the terminal cannot kill it midway (see openColabSession).
    const child = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", signal, detached: args[0] === "new" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    signal?.throwIfAborted();
    if (child.exitCode === 0) return stdout;
    // Parallel jobs share the CLI's local session database, which another CLI process can hold for a moment.
    if (stderr.includes("unable to open database") && attempt < 5) {
      await scheduler.wait(attempt * 3_000, { signal });
      continue;
    }
    // A dropped connection to the VM fails a whole job for a moment's network trouble; transfers and reads can simply
    // run again, while an exec may already have run and is left to its own recovery.
    if (idempotent.has(args[0]!) && transient.test(stderr) && attempt < 4) {
      await scheduler.wait(attempt * 10_000, { signal });
      continue;
    }
    throw new Error(tail(`${stdout}\n${stderr}`, 2000) || `Colab CLI exited with code ${child.exitCode}`);
  }
}

const heartbeatPath = "/content/.toonflowHeartbeat";
// Touched by every exec, so the VM knows when the host last reached it.
const seenPath = "/content/.toonflowSeen";

/**
 * A separate process on the VM that releases it through Colab's runtime service (the POST behind
 * google.colab.runtime.unassign) once the kernel is idle and the host has not reached it for releaseAfter. The host
 * normally stops its sessions itself; this covers a host that cannot (offline, asleep, crashed), so a forgotten GPU
 * bills at most the running job plus releaseAfter. A job counts as running for at most execTimeout, so a hung kernel
 * is released too.
 */
const watchdogScript = `import json, os, time, urllib.request
last, busySince = time.time(), None
while True:
    time.sleep(60)
    now = time.time()
    try:
        with open("${heartbeatPath}") as file:
            beat = json.load(file)
        busy = now - beat["beat"] < 120 and beat["current"] is not None and beat["current"] != beat["finished"]
    except Exception:
        busy = False
    busySince = (busySince or now) if busy else None
    if busy and now - busySince < ${execTimeout}:
        last = now
    last = max(last, os.path.getmtime("${seenPath}"))
    if now - last > ${releaseAfter / 1000}:
        try:
            urllib.request.urlopen(urllib.request.Request("http://" + os.environ["TBE_RUNTIME_ADDR"] + "/unassign", method="POST"), timeout=30)
            print("released", time.ctime(now), flush=True)
            break
        except Exception as error:
            print("release failed, retrying:", error, flush=True)
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
    toonflowState = {"current": None, "finished": None, "error": None}
    def toonflowFinished(result):
        error = None if result.success else repr(result.error_in_exec or result.error_before_exec)
        toonflowState.update(finished=toonflowState["current"], error=error)
    get_ipython().events.register("post_run_cell", toonflowFinished)
    def toonflowHeartbeat():
        while True:
            with open("${heartbeatPath}.tmp", "w") as file:
                json.dump({"beat": time.time(), **toonflowState}, file)
            os.replace("${heartbeatPath}.tmp", "${heartbeatPath}")
            time.sleep(15)
    threading.Thread(target=toonflowHeartbeat, daemon=True).start()
    import subprocess, sys
    open("${seenPath}", "a").close()
    subprocess.Popen([sys.executable, "-c", ${JSON.stringify(watchdogScript)}], cwd="/content", start_new_session=True,
                     stdout=open("/content/.toonflowWatchdog.log", "a"), stderr=subprocess.STDOUT)
print("COLAB_DONE")
`;

const stateLost = "TOONFLOW_KERNEL_STATE_LOST";
/**
 * A hung CLI exec can leave the session on a new kernel while the old one keeps its memory (a loaded model) and its
 * heartbeat, so every job first checks that it runs in the kernel the heartbeat started in.
 */
const stateCheck = `if "toonflowState" not in globals():\n    raise RuntimeError("${stateLost}")\n`;

const beatSchema = z.object({ beat: z.number(), current: z.string().nullable(), finished: z.string().nullable(), error: z.string().nullable() });

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
 * reading of the heartbeat (every 45 s) tells these apart, and the exec is aborted with the reason once one holds.
 */
function watchHeartbeat(command: string, session: string, directory: string, execId: string, controller: AbortController) {
  const local = join(directory, "heartbeat");
  let lastBeat = 0;
  let missed = 0;
  let waiting = 0;
  let finished = 0;
  let reading = false;
  const lost = (detail: ExecLost) => controller.abort(detail);
  const timer = setInterval(async () => {
    if (reading) return;
    reading = true;
    const state = await colab(command, ["download", "--session", session, heartbeatPath, local], AbortSignal.timeout(40_000))
      .then(async () => beatSchema.parse(JSON.parse(await readFile(local, "utf8"))), () => undefined)
      .finally(() => { reading = false; });
    missed = state && state.beat !== lastBeat ? 0 : missed + 1;
    lastBeat = state?.beat ?? lastBeat;
    if (missed >= 4) return lost({ reason: "kernelLost" });
    if (!state) return;
    if (state.finished === execId) {
      if (++finished >= 2) lost({ reason: "finished", error: state.error });
    } else if (state.current !== execId && ++waiting >= 3) {
      lost({ reason: "notStarted" });
    }
  }, 45_000);
  return () => clearInterval(timer);
}

function checkJob({ uploads, env, outputs }: Omit<ColabJob, "provider">) {
  // Every value below reaches argv, so only plain tokens are accepted; free text travels as uploaded files.
  for (const { name } of uploads) if (!/^[\w.-]+$/.test(name)) throw new Error(`Invalid Colab upload file name: ${name}`);
  for (const [name, value] of Object.entries(env)) if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !/^[\w.:-]+$/.test(String(value))) throw new Error(`Invalid Colab environment variable: ${name}`);
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
export async function openColabSession(provider: string, { gpu, highMem }: ColabMachine, signal?: AbortSignal) {
  await checkColabBudget(provider);
  const command = findCommand("colab", "Colab CLI not found. Install google-colab-cli and run `colab sessions` in a terminal to sign in with Google");
  await guardColabLog();
  const directory = await mkdtemp(join(tmpdir(), "toonflow-colab-"));
  const name = `toonflow-${crypto.randomUUID().slice(0, 8)}`;
  let startedAt = 0;
  let hourlyRate = fallbackHourlyRate;
  let files = 0;
  let stopped = false;

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
    return stdout;
  }

  /**
   * Starts the heartbeat. The first execs of a new session may hang before reaching the kernel or time out while the
   * machine's proxy comes up, so it is retried; the script starts nothing twice.
   */
  async function startHeartbeat(signal?: AbortSignal) {
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
    for (let attempt = 1; ; attempt++) {
      const execId = `${name}-${files}`;
      const path = join(directory, `script${files++}.py`);
      await writeFile(path, `${stateCheck}__import__("os").utime("${seenPath}")\ntoonflowState.update(current="${execId}", finished=None, error=None)\n${script}`);
      const watcher = new AbortController();
      const stopWatching = watchHeartbeat(command, name, directory, execId, watcher);
      const result = await spawnExec(path, env, signal ? AbortSignal.any([signal, watcher.signal]) : watcher.signal).finally(stopWatching);
      signal?.throwIfAborted();
      if (!watcher.signal.aborted) return checkOutput(result);
      const lost = watcher.signal.reason as ExecLost;
      // The job never reached the kernel, so running it again cannot run it twice.
      if (lost.reason === "notStarted" && attempt < 2) continue;
      if (lost.reason === "notStarted") throw new Error(`Colab could not start the job on session ${name}: ${tail(result.stderr, 1000)}`);
      // The kernel finished but the CLI lost its connection, so the outcome comes from the kernel's own report.
      if (lost.reason === "finished") {
        if (lost.error) throw new ColabScriptError(`Colab job failed: ${lost.error}`);
        return result.stdout;
      }
      // The VM outlives its kernel, so read why it died before the session is stopped; the exec output so far is kept.
      const report = join(directory, "diagnose.py");
      await writeFile(report, diagnoseScript);
      const details = await colab(command, ["exec", "--session", name, "--timeout", "60", "--file", report], AbortSignal.timeout(90_000)).catch(() => "");
      throw new Error(`The Colab kernel stopped responding (session ${name}); it crashed, ran out of memory or lost its VM\n${tail(details)}\nLast job output:\n${tail(`${result.stdout}\n${result.stderr}`)}`);
    }
  }

  /**
   * Runs a plain Python script (no IPython syntax) as a background process on the VM and checks on it with short
   * execs, so a job of hours, such as LoRA training, survives the host losing its network for a while.
   */
  async function runDetached(prelude: string, script: string, env: ColabJob["env"], signal?: AbortSignal) {
    const id = `toonflowJob${files++}`;
    const local = join(directory, `upload${files++}`);
    await writeFile(local, script);
    await colab(command, ["upload", "--session", name, local, `/content/${id}.py`], signal);
    // The shell writes the exit status once the script ends; the kernel only starts it and returns. Each check is an
    // exec, so it also tells the session watchdog the host is still there.
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
      if (state[1] !== "0" || state[2] !== "TOONFLOW_SCRIPT_DONE") throw new ColabScriptError(`Colab job failed (exit ${state[1]}): ${tail(output, 2000)}`);
      return;
    }
  }

  /**
   * Uploads the inputs, runs the script and downloads the outputs. A detached job runs as a background process that
   * the host checks on, for jobs that run longer than a network connection can be trusted to last.
   */
  async function job({ script, uploads, env, outputs, detached = false }: Omit<ColabJob, "provider"> & { detached?: boolean }, signal?: AbortSignal) {
    checkJob({ script, uploads, env, outputs });
    const split: [string, number][] = [];
    for (const { name: remote, data } of uploads) {
      const parts = typeof data === "string" || data.length <= uploadPart ? [data]
        : Array.from({ length: Math.ceil(data.length / uploadPart) }, (_, index) => data.subarray(index * uploadPart, (index + 1) * uploadPart));
      for (const [index, part] of parts.entries()) {
        const local = join(directory, `upload${files++}`);
        await writeFile(local, part);
        await colab(command, ["upload", "--session", name, local, `/content/${parts.length > 1 ? `${remote}.part${index}` : remote}`], signal);
      }
      if (parts.length > 1) split.push([remote, parts.length]);
    }
    const joinParts = split.length ? `import os as _toonflowOs
for _name, _count in ${JSON.stringify(split)}:
    with open(f"/content/{_name}", "wb") as _whole:
        for _index in range(_count):
            with open(f"/content/{_name}.part{_index}", "rb") as _part:
                _whole.write(_part.read())
            _toonflowOs.remove(f"/content/{_name}.part{_index}")
` : "";
    if (detached) await runDetached(joinParts, script, env, signal);
    else await exec(joinParts + script, env, signal);
    const results: Uint8Array[] = [];
    for (const remote of outputs) {
      const local = join(directory, `output${files++}`);
      await colab(command, ["download", "--session", name, remote, local], signal);
      results.push(new Uint8Array(await readFile(local)));
    }
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
      if (Date.now() - firstTry > stopRetry) throw new Error(`Colab session ${name} could not be stopped; run colab stop --session ${name} so it stops billing${reason}`, { cause: failure });
      await scheduler.wait(30_000);
    }
    stopped = true;
    activeSessions.delete(name);
    releaseMachine();
    if (startedAt) await recordColabUnits(provider, (Date.now() - startedAt) / 3_600_000 * hourlyRate);
    await rm(directory, { recursive: true, force: true });
  }

  // Taken last before the try, whose failure path stops the session and so frees the machine again.
  const releaseMachine = await acquireMachine(gpu, signal);
  guardProcessExit();
  // Tracked before `new` returns, because an interrupted `new` can still leave the session running.
  activeSessions.set(name, command);
  try {
    // Colab refuses a new session while the account's GPU sessions are taken (about three, fewer of one kind) and
    // answers 503 while it is short of machines, so such a start waits and retries instead of failing a job that may
    // follow paid steps. A 503 may still have assigned a machine, so it is stopped before the next try.
    for (const waitStart = Date.now(); ; ) {
      try {
        startingSessions.add(name);
        // Never cancelled midway: a killed `new` can leave an assigned machine the CLI never recorded, which nothing can
        // stop; a cancelled start is stopped once `new` returns.
        await colab(command, ["new", "--session", name, "--gpu", gpu, ...highMem ? ["--high-mem"] : []]).finally(() => startingSessions.delete(name));
        break;
      } catch (error) {
        if (!/Allocation refused|Service Unavailable/.test(String(error)) || Date.now() - waitStart > allocationWait) throw error;
        await colab(command, ["stop", "--session", name]).catch(() => undefined);
        await scheduler.wait(60_000, { signal });
      }
    }
    startedAt = Date.now();
    signal?.throwIfAborted();
    // ACT: The account-wide rate right after start stands for this session; with parallel sessions it over-counts.
    hourlyRate = Number(/Usage rate:\s*([\d.]+)/.exec(await colab(command, ["usage"]).catch(() => ""))?.[1]) || fallbackHourlyRate;
    await startHeartbeat(signal);
  } catch (error) {
    await close(error);
    throw error;
  }
  return { name, job, close };
}

/**
 * Keeps one Colab session open across jobs so state a job loads into the kernel, such as model weights, serves the
 * next one. Jobs run one at a time in arrival order. The session stops after `idleMs` without jobs (never while one
 * runs or waits), on stop(), and when a job fails for any reason other than its own Python error, because a
 * cancelled exec, a lost kernel or a CLI failure leaves the kernel in an unknown state.
 */
export function createColabWorker(provider: string, machine: ColabMachine, idleMs: number) {
  let session: ColabSession | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let epoch = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | undefined;
  let stopSoon = false;

  async function close(failure?: unknown) {
    const open = session;
    if (!open) return;
    await open.close(failure);
    session = undefined;
  }

  function enqueue<T>(step: () => Promise<T>) {
    const result = queue.then(step);
    queue = result.catch(() => {});
    return result;
  }

  function scheduleIdleStop() {
    clearTimeout(idleTimer);
    const wait = stopSoon ? 0 : idleMs;
    stopSoon = false;
    idleTimer = setTimeout(() => {
      // Queued behind running jobs, and skipped when a job arrived meanwhile.
      void enqueue(() => pending ? Promise.resolve() : close())
        .catch((error: unknown) => console.error("[colab] Idle session stop failed; check with `colab sessions`:", error));
    }, wait);
    // A pending idle stop must not keep the process alive; the exit handlers stop the session instead.
    idleTimer.unref();
  }

  function run<T>(task: (session: ColabSession, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    clearTimeout(idleTimer);
    pending++;
    const queuedEpoch = epoch;
    const result = enqueue(async () => {
      signal?.throwIfAborted();
      if (queuedEpoch !== epoch) throw new Error("The Colab session was stopped");
      const controller = running = new AbortController();
      const jobSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        session ??= await openColabSession(provider, machine, jobSignal);
        return await task(session, jobSignal);
      } catch (error) {
        if (!(error instanceof ColabScriptError)) await close(error);
        throw error;
      } finally {
        running = undefined;
      }
    }).finally(() => {
      if (--pending === 0 && session) scheduleIdleStop();
    });
    if (!signal) return result;
    // A cancelled request returns at once even while it waits for its turn; the queue skips it when its turn comes.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  /**
   * Keeps an open session from its idle stop, as a running job does, until the returned release is called; for a
   * caller whose jobs come with gaps longer than `idleMs` in between. The caller must release in a finally block.
   */
  function hold() {
    clearTimeout(idleTimer);
    pending++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      if (--pending === 0 && session) scheduleIdleStop();
    };
  }

  /**
   * Stops the session once no job runs or waits, instead of after `idleMs`, for a caller that knows no more jobs follow;
   * other callers' queued jobs still run first.
   */
  function stopWhenIdle() {
    stopSoon = true;
    if (!pending && session) scheduleIdleStop();
  }

  /** Stops the session now, cancelling the running job and every queued one. */
  function stop() {
    clearTimeout(idleTimer);
    epoch++;
    running?.abort(new Error("The Colab session was stopped"));
    return enqueue(() => close());
  }

  return { run, hold, stopWhenIdle, stop };
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
