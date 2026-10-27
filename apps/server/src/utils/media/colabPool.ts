import { endLocalColabCalls, openColabSession, readColabSessionStatus, stopColabSession, strayColabSessions, ColabScriptError, ColabConnectionError, ColabSessionGoneError, type ColabMachine, type ColabSession, type ColabJob } from "./colab";
import { z } from "zod";
import { dirname, join } from "node:path";
import { readFile, writeAtomic } from "@toonflow/file";
import conf from "@/utils/conf";
import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
import { machineCapacitySchema, recordColabTiming } from "./timings";

export type ColabAllocation = { speechLane: 1 | 2; reviewLane: 1 | 2 | 3; speechMode?: "eager" | "compiled"; speechRuntime?: "vllm" | "sglang"; renderWorkers: 1 | 2; renderLimit?: number; lanes: number[]; ready?: (model: string) => Promise<void> };
const allocation = new AsyncLocalStorage<ColabAllocation>();
export const withColabAllocation = <T>(value: ColabAllocation, work: () => T) => allocation.run({ ...value }, work);
export const currentColabAllocation = () => allocation.getStore();
export async function waitForColabPreparation(model: string, signal?: AbortSignal) {
  const context = allocation.getStore();
  if (!context?.ready) return;
  const began = performance.now();
  let passed = false;
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); reject(signal!.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      context.ready!(model).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
      if (signal?.aborted) abort();
    });
    passed = true;
  }
  finally { void recordColabTiming({ role: model, phase: "readiness", gpu: model === "text" ? "L4" : "A100", seconds: (performance.now() - began) / 1000, passed }); }
}
// Requests outside a production use two A100s (the user's choice on 2026-10-27, as one disk could not hold every model):
// lane 2 holds MiniMax H3 and Drama 3, the dialogue shots, and lane 1 every other model. A production's allocation
// still spreads its speech and review over the lanes it planned.
export const colabLane = (index: number) => {
  const planned = allocation.getStore();
  if (!planned) return index === 0 ? 0 : index === 2 ? 2 : 1;
  return index === 2 ? planned.speechLane : index === 3 ? planned.reviewLane : index;
};
export type ColabPreparation = { name: string; runtime: string; installSource: string; prefetch?: boolean; deferLoad?: boolean; timingOutput?: string; job: Omit<ColabJob, "provider"> };

// One text lane and three high-RAM GPU lanes share installed environments across production stages.
const machines: ColabMachine[] = [{ gpu: "L4", highMem: true }, ...Array.from({ length: 3 }, () => ({ gpu: "A100" as const, highMem: true }))];
const lanes = machines.map(machine => ({ machine, session: undefined as ColabSession | undefined, closedAt: undefined as string | undefined, capacity: undefined as z.infer<typeof machineCapacitySchema> | undefined, prepared: new Set<string>(), queue: Promise.resolve() as Promise<unknown>, pending: 0, controller: undefined as AbortController | undefined }));
const checkpointPath = () => join(dirname(conf.path), "colabPool.json");
// Machines that started but were never taken into use; the user's stop command stops them with the others.
const strayPath = () => join(dirname(conf.path), "colabStrays.json");
let checkpointQueue: Promise<unknown> = Promise.resolve();
let poolReady: Promise<void> | undefined;
function saveCheckpoint() {
  const next = checkpointQueue.then(async () => {
    await writeAtomic(strayPath(), JSON.stringify([...strayColabSessions].map(([name, gpu]) => ({ name, gpu }))));
    await writeAtomic(checkpointPath(), JSON.stringify(lanes.flatMap((lane, index) => lane.session ? [{ lane: index, name: lane.session.name, prepared: [...lane.prepared], capacity: lane.capacity }] : [])));
  });
  checkpointQueue = next.catch(() => {});
  return next;
}

/** Reconnect registered machines before allowing new GPU work. */
export function restoreColabPool(signal: AbortSignal) {
  return poolReady ??= restoreSavedPool(signal);
}

/** Settles when the machines of before a restart are back in their lanes, so a choice of lane sees them. */
export const colabPoolRestored = () => Promise.resolve(poolReady).catch(() => {});

async function restoreSavedPool(signal: AbortSignal) {
  const schema = z.array(z.strictObject({ lane: z.number().int().min(0).max(3), name: z.string().regex(/^toonflow-[0-9a-f]{8}$/), prepared: z.array(z.string().min(1).max(64)).max(12), capacity: machineCapacitySchema.optional() })).max(4).refine(rows => new Set(rows.map(row => row.lane)).size === rows.length && new Set(rows.map(row => row.name)).size === rows.length);
  const saved = await readFile(checkpointPath(), "utf8").then(text => schema.parse(JSON.parse(text)), (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const strays = await readFile(strayPath(), "utf8").then(text => z.array(z.strictObject({ name: z.string().regex(/^toonflow-[0-9a-f]{8}$/), gpu: z.enum(["L4", "A100"]) })).max(64).parse(JSON.parse(text)), (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  strays.forEach(({ name, gpu }) => strayColabSessions.set(name, gpu));
  const results = await Promise.allSettled(saved.map(item => enqueue(item.lane, async (lane, jobSignal) => {
    const adopted = await adopt(lane, item.name, jobSignal).catch((error: unknown) => {
      // Only the user stops machines: one that cannot be taken back keeps running, and a lane that needs a machine
      // tries it again before asking Colab for a new one.
      if (jobSignal.aborted) throw error;
      strayColabSessions.set(item.name, lane.machine.gpu);
      throw new Error(`${error instanceof Error ? error.message : error}; it was left running until the machines are stopped`, { cause: error });
    });
    if (!adopted) return;
    if (adopted === "idle") lane.prepared = new Set(item.prepared);
    lane.capacity = item.capacity;
  }, signal)));
  // A machine that cannot be taken back is reported and left out; the other lanes and all new work go on, as failing
  // the whole pool made every later job fail until the next restart, which met the same stale checkpoint.
  for (const result of results) if (result.status === "rejected") console.error("[colab] A machine was not reconnected:", result.reason instanceof Error ? result.reason.message : result.reason);
  if (lanes.some(lane => lane.session)) ensureKeepAlive();
  await saveCheckpoint();
}

// The waits before each retry of taking a machine back: a transient CLI error dropped healthy machines for good.
const adoptWaits = [15_000, 30_000, 60_000];

/**
 * Takes a running machine into a lane: this computer's leftover CLI calls to it are ended, its state is read, and a job
 * still running from before a restart, whose result no one can take, is ended by a reset that also unloads its models.
 * A failed attempt is retried after a growing wait. Resolves to its state before, or undefined when Colab took it back.
 */
async function adopt(lane: (typeof lanes)[number], name: string, signal: AbortSignal) {
  await endLocalColabCalls(name);
  for (let attempt = 0; ; attempt++) {
    try {
      const status = await readColabSessionStatus(name);
      const { state } = status;
      if (state === "off") { strayColabSessions.delete(name); return undefined; }
      // A machine whose heartbeat stopped may still run a job outside its kernel, so it is taken back and reset like a
      // working one; left unread, it stayed out of the pool for good after a restarted kernel.
      const stale = "stale" in status && status.stale;
      if (state === "unknown" && !stale) throw new Error(`The state of Colab machine ${name} could not be read`);
      const session = await openColabSession("production", lane.machine, signal, name);
      if (state === "working" || stale) await session.reset(signal);
      lane.closedAt = undefined;
      lane.session = session;
      lane.prepared.clear();
      strayColabSessions.delete(name);
      return state;
    } catch (error) {
      if (signal.aborted || attempt === adoptWaits.length) throw error;
      console.warn(`[colab] Taking back ${name} failed, retrying:`, error instanceof Error ? error.message : error);
      await scheduler.wait(adoptWaits[attempt]!, { signal });
    }
  }
}

/** A lane without a machine takes back a stray of its GPU before asking Colab for a new one, which the account may refuse. */
async function laneSession(lane: (typeof lanes)[number], provider: string, signal: AbortSignal) {
  for (const [name, gpu] of strayColabSessions) {
    if (gpu !== lane.machine.gpu || lanes.some(other => other.session?.name === name)) continue;
    if (await adopt(lane, name, signal).catch(error => { if (signal.aborted) throw error; return undefined; })) {
      await saveCheckpoint();
      return lane.session!;
    }
  }
  return openColabSession(provider, lane.machine, signal);
}

// ACT: an A100 lane without a machine runs its job on another A100 lane's running machine instead of opening one: a
// new machine reinstalls its models for minutes and bills beside the idle one (2026-10-27, the user's choice). That disk
// holds LUSTIFY, V5 and Drama 3 (about 137 GB of 236 GB, measured 2026-10-27); H3 (40 GB) on top leaves little room, so
// bring back a machine of its own here when H3 returns to the pipeline.
class BorrowLane extends Error {
  constructor(readonly host: number) { super(`Borrow lane ${host}`); }
}

export const colabModelPrepared = (index: number, model: string) => lanes[index]?.prepared.has(model) ?? false;
export const colabSessionName = (index: number) => lanes[index]?.session?.name;
/** Jobs queued or running on a lane. */
export const colabLanePending = (index: number) => lanes[index]?.pending ?? 0;
export async function rememberColabCapacity(index: number, name: string, capacity: z.infer<typeof machineCapacitySchema>) {
  const lane = lanes[index];
  if (lane?.session?.name !== name) throw new Error("Machine changed while recording capacity");
  lane.capacity = machineCapacitySchema.parse(capacity);
  await saveCheckpoint();
}
export async function markColabModelPrepared(index: number, model: string) {
  const lane = lanes[index];
  if (!lane?.session) throw new Error("Cannot prepare a model without its physical machine");
  lane.prepared.add(model);
  await saveCheckpoint();
}
let holds = 0;
let epoch = 0;
let generation = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
let keepingAlive = false;
let stopping: Promise<void> | undefined;

/** Marks the machines as working, including idle models awaiting a review or a retry. It does not allocate machines. */
export function holdColabPool() {
  holds++;
  ensureKeepAlive();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds--;
  };
}

/** Colab took the lane's VM back: the lane lets it go, so the next job starts a new machine. */
async function letGone(lane: typeof lanes[number]) {
  if (!lane.session) return;
  await lane.session.forget();
  lane.closedAt = new Date().toISOString();
  lane.session = undefined;
  lane.capacity = undefined;
  lane.prepared.clear();
  generation++;
  await saveCheckpoint();
}

function ensureKeepAlive() {
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(async () => {
      if (keepingAlive) return;
      keepingAlive = true;
      try {
        const results = await Promise.allSettled(lanes.flatMap((lane, index) => lane.session && !lane.pending ? [enqueue(index, async (current, signal) => {
          try { await current.session?.keepAlive(signal); } catch (error) {
            if (error instanceof ColabSessionGoneError) await letGone(current);
            throw error;
          }
        }, AbortSignal.timeout(40_000))] : []));
        results.forEach(result => { if (result.status === "rejected") console.error("[colabPool] Keepalive failed:", result.reason); });
      } finally { keepingAlive = false; }
    }, 5 * 60_000);
    keepAliveTimer.unref();
  }
}

const statusReads = new WeakMap<ColabSession, { at: number; result: ReturnType<typeof readColabSessionStatus> }>();

/** Read-only status probes bypass the generation queue. */
export async function readColabPoolStatus() {
  const rows = await Promise.all(lanes.map(async (lane, index) => {
    const identity = { lane: index, gpu: lane.machine.gpu };
    const session = lane.session;
    const checkedAt = new Date().toISOString();
    if (stopping && (session || lane.pending)) return { ...identity, state: "stopping" as const, checkedAt };
    if (!session) return { ...identity, state: lane.pending ? "starting" as const : lane.closedAt ? "off" as const : "disconnected" as const, checkedAt };
    let probe = statusReads.get(session);
    if (!probe || Date.now() - probe.at >= 10_000) {
      probe = { at: Date.now(), result: readColabSessionStatus(session.name) };
      statusReads.set(session, probe);
    }
    const power = await probe.result;
    if (lane.session !== session) return { ...identity, state: lane.closedAt ? "off" as const : "unknown" as const, checkedAt: new Date().toISOString() };
    if (stopping) return { ...identity, state: "stopping" as const, checkedAt: new Date().toISOString() };
    return { ...identity, ...power, state: lane.pending && power.state === "idle" ? "working" as const : power.state };
  }));
  const working = !!holds || lanes.some(lane => lane.pending > 0);
  return {
    checkedAt: new Date().toISOString(),
    machines: rows.filter(row => row.lane < 3 || row.state !== "disconnected"),
    working,
  };
}

function enqueue<T>(index: number, work: (lane: typeof lanes[number], signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
  if (stopping) throw new Error("The Colab pool is stopping");
  signal?.throwIfAborted();
  const lane = lanes[index];
  if (!lane) throw new Error("Invalid Colab execution lane");
  const queuedEpoch = epoch;
  let started = false;
  lane.pending++;
  const result = lane.queue.then(async () => {
    started = true;
    signal?.throwIfAborted();
    if (queuedEpoch !== epoch) throw new Error("The Colab pool was stopped");
    const controller = lane.controller = new AbortController();
    try { return await work(lane, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); }
    finally { lane.controller = undefined; }
  }).finally(() => { lane.pending--; });
  lane.queue = result.catch(() => {});
  if (!signal) return result;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { if (!started) reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Allocates every production lane before model preparation begins. No model job is sent by this function. */
export async function startColabPool(signal: AbortSignal, required: number[]) {
  await poolReady;
  const results = await Promise.allSettled(required.map(index => enqueue(index, async (lane, jobSignal) => {
    if (!lane.session) lane.closedAt = undefined;
    lane.session ??= await laneSession(lane, "production", jobSignal);
    ensureKeepAlive();
    await saveCheckpoint();
    return lane.session.name;
  }, signal)));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}

export const colabPoolEpoch = () => generation;

export const colabPoolIdle = () => !holds && lanes.every(lane => !lane.pending);

/** Maintenance uses the same queue as inference and cannot allocate or replace a VM. */
export function useExistingColabSession<T>(index: number, name: string, work: (session: ColabSession, signal: AbortSignal) => Promise<T>, signal: AbortSignal) {
  return enqueue(index, async (lane, jobSignal) => {
    if (lane.session?.name !== name) throw new Error("Runtime cache session is no longer owned by this pool");
    return work(lane.session, jobSignal);
  }, signal);
}

export async function inspectColabPool(signal: AbortSignal, required: number[]) {
  signal.throwIfAborted();
  return required.map(index => {
    const lane = lanes[index];
    if (!lane?.session || !lane.capacity) throw new Error("Model preparation has not supplied a verified machine capacity snapshot");
    return { lane: index, session: lane.session.name, ...lane.capacity };
  });
}

/**
 * The user's stop command, the only way machines are stopped: it cancels running work, drains queued jobs, stops the
 * machines that were never taken into use and verifies each physical VM was released.
 */
export function stopColabPool() {
  if (stopping) return stopping;
  clearInterval(keepAliveTimer);
  keepAliveTimer = undefined;
  epoch++;
  generation++;
  lanes.forEach(lane => lane.controller?.abort(new Error("The Colab pool was stopped")));
  stopping = (async () => {
    const results = await Promise.allSettled([...[...strayColabSessions.keys()].map(async name => {
      await stopColabSession(name);
      await saveCheckpoint();
    }), ...lanes.map(async lane => {
      await lane.queue;
      if (!lane.session) return;
      await lane.session.close();
      lane.closedAt = new Date().toISOString();
      lane.session = undefined;
      lane.capacity = undefined;
      lane.prepared.clear();
      await saveCheckpoint();
    })]);
    const failed = results.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
  })().finally(() => { stopping = undefined; });
  return stopping;
}

/** Logical model workers share a physical lane; their GPU processes are isolated and switched without deleting the VM. */
export function createColabWorker(provider: string, index: number) {
  const facades = new WeakMap<ColabSession, ColabSession>();
  function run<T>(task: (session: ColabSession, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    const queuedAt = performance.now();
    const queuedAtUtc = new Date().toISOString();
    const attempt = (physicalIndex: number): Promise<T> => enqueue(physicalIndex, async (lane, jobSignal) => {
      const enteredAt = performance.now();
      const reused = !!lane.session;
      let readyAt: number | undefined;
      let passed = false;
      try {
        if (!lane.session) lane.closedAt = undefined;
        const host = lane.session || lane.machine.gpu !== "A100" ? -1 : lanes.findIndex((other, at) => at !== physicalIndex && other.machine.gpu === "A100" && !!other.session);
        if (host >= 0) throw new BorrowLane(host);
        lane.session ??= await laneSession(lane, provider, jobSignal);
        ensureKeepAlive();
        await saveCheckpoint();
        readyAt = performance.now();
        await lane.session.attribute(provider);
        let facade = facades.get(lane.session);
        if (!facade) {
          const physical = lane.session;
          facade = { ...physical, job: (request, signal) => physical.job({ ...request, runtime: request.runtime ?? provider }, signal) };
          facades.set(physical, facade);
        }
        const result = await task(facade, jobSignal);
        passed = true;
        return result;
      } catch (error) {
        // A disconnected/cancelled kernel cannot safely hand its GPU state to another model, so its kernel is restarted;
        // only the user stops machines, and a machine is let go here only once Colab no longer has it.
        if (error instanceof ColabSessionGoneError) await letGone(lane);
        else if (!(error instanceof ColabConnectionError) && (!(error instanceof ColabScriptError) || error.unsafe) && lane.session) {
          const session = lane.session;
          lane.capacity = undefined;
          lane.prepared.clear();
          generation++;
          try { await session.reset(); } catch (resetError) {
            if ((await readColabSessionStatus(session.name)).state !== "off") throw new Error(`${error instanceof Error ? error.message : error}; restarting the kernel of ${session.name} also failed (${resetError instanceof Error ? resetError.message : resetError}), and the machine was left running`, { cause: error });
            await letGone(lane);
          } finally { await saveCheckpoint(); }
        }
        await saveCheckpoint();
        throw error;
      } finally {
        const now = performance.now();
        const role = provider === "colab" ? index === 0 ? "text" : "visualReview" : provider === "drama3" ? allocation.getStore()?.speechRuntime === "sglang" ? "drama3Sglang" : allocation.getStore()?.speechMode === "compiled" ? "drama3Compiled" : "drama3Eager" : provider;
        const observation = { role, gpu: lane.machine.gpu, passed };
        if (!reused) void recordColabTiming({ ...observation, passed: readyAt !== undefined, phase: "allocation", seconds: ((readyAt ?? now) - enteredAt) / 1000 });
        void recordColabTiming({ ...observation, phase: "queue", seconds: (enteredAt - queuedAt) / 1000 });
        if (readyAt !== undefined) void recordColabTiming({ ...observation, phase: "job", seconds: (now - readyAt) / 1000 });
        console.log("[colabTiming]", JSON.stringify({ provider, lane: physicalIndex, session: lane.session?.name, queuedAtUtc, finishedAtUtc: new Date().toISOString(), reused, passed, queueSeconds: (enteredAt - queuedAt) / 1000, startupSeconds: ((readyAt ?? now) - enteredAt) / 1000, jobSeconds: readyAt === undefined ? 0 : (now - readyAt) / 1000 }));
      }
    }, signal).catch((error: unknown) => {
      if (!(error instanceof BorrowLane)) throw error;
      console.log(`[colab] ${provider} runs on the running ${lanes[error.host]!.session?.name}`);
      return attempt(error.host);
    });
    return Promise.resolve(poolReady).then(() => attempt(colabLane(index)));
  }
  function holdFor(ms: number, signal?: AbortSignal) {
    const release = holdColabPool();
    const timer = setTimeout(release, ms);
    timer.unref();
    signal?.addEventListener("abort", release, { once: true });
    return () => { clearTimeout(timer); signal?.removeEventListener("abort", release); release(); };
  }
  return { run, hold: holdColabPool, holdFor };
}

/** Flush ownership before a web-service restart; this never stops a remote VM. */
export async function checkpointColabPool() {
  await saveCheckpoint();
}
