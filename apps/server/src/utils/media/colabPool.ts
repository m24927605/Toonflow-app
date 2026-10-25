import { openColabSession, readColabSessionStatus, stopColabSession, strayColabSessions, ColabScriptError, ColabConnectionError, type ColabMachine, type ColabSession, type ColabJob } from "./colab";
import { z } from "zod";
import { dirname, join } from "node:path";
import { readFile, writeAtomic } from "@toonflow/file";
import conf from "@/utils/conf";
import { AsyncLocalStorage } from "node:async_hooks";
import { scheduler } from "node:timers/promises";
import { machineCapacitySchema, recordColabTiming } from "./timings";

export type ColabAllocation = { speechLane: 1 | 2; reviewLane: 1 | 3; speechMode?: "eager" | "compiled"; speechRuntime?: "vllm" | "sglang"; renderWorkers: 1 | 2; renderLimit?: number; lanes: number[]; ready?: (model: string) => Promise<void> };
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
export const colabLane = (index: number) => index === 2 ? allocation.getStore()?.speechLane ?? 2 : index === 3 ? allocation.getStore()?.reviewLane ?? 3 : index;
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
    await writeAtomic(strayPath(), JSON.stringify([...strayColabSessions]));
    await writeAtomic(checkpointPath(), JSON.stringify(lanes.flatMap((lane, index) => lane.session ? [{ lane: index, name: lane.session.name, prepared: [...lane.prepared], capacity: lane.capacity }] : [])));
  });
  checkpointQueue = next.catch(() => {});
  return next;
}

/** Reconnect registered machines before allowing new GPU work. */
export function restoreColabPool(signal: AbortSignal) {
  return poolReady ??= restoreSavedPool(signal);
}

async function restoreSavedPool(signal: AbortSignal) {
  const schema = z.array(z.strictObject({ lane: z.number().int().min(0).max(3), name: z.string().regex(/^toonflow-[0-9a-f]{8}$/), prepared: z.array(z.string().min(1).max(64)).max(12), capacity: machineCapacitySchema.optional() })).max(4).refine(rows => new Set(rows.map(row => row.lane)).size === rows.length && new Set(rows.map(row => row.name)).size === rows.length);
  const saved = await readFile(checkpointPath(), "utf8").then(text => schema.parse(JSON.parse(text)), (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const strays = await readFile(strayPath(), "utf8").then(text => z.array(z.string().regex(/^toonflow-[0-9a-f]{8}$/)).max(64).parse(JSON.parse(text)), (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  strays.forEach(name => strayColabSessions.add(name));
  const results = await Promise.allSettled(saved.map(item => enqueue(item.lane, async (lane, jobSignal) => {
    // A status read right after a restart may time out, so an unknown state is read again before it counts.
    let status = await readColabSessionStatus(item.name);
    for (let attempt = 1; status.state === "unknown" && attempt < 3; attempt++) {
      await scheduler.wait(10_000, { signal: jobSignal });
      status = await readColabSessionStatus(item.name);
    }
    if (status.state === "off") { lane.closedAt = new Date().toISOString(); return; }
    try {
      if (status.state !== "idle") throw new Error(`Existing Colab machine ${item.name} is ${status.state}`);
      lane.closedAt = undefined;
      lane.session = await openColabSession("production", lane.machine, jobSignal, item.name);
    } catch (error) {
      // Only the user stops machines: one that cannot be taken back keeps running and is stopped with the others.
      if (jobSignal.aborted) throw error;
      strayColabSessions.add(item.name);
      throw new Error(`${error instanceof Error ? error.message : error}; it was left running until the machines are stopped`, { cause: error });
    }
    lane.prepared = new Set(item.prepared);
    lane.capacity = item.capacity;
  }, signal)));
  // A machine that cannot be taken back is reported and left out; the other lanes and all new work go on, as failing
  // the whole pool made every later job fail until the next restart, which met the same stale checkpoint.
  for (const result of results) if (result.status === "rejected") console.error("[colab] A machine was not reconnected:", result.reason instanceof Error ? result.reason.message : result.reason);
  if (lanes.some(lane => lane.session)) ensureKeepAlive();
  await saveCheckpoint();
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

function ensureKeepAlive() {
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(async () => {
      if (keepingAlive) return;
      keepingAlive = true;
      try {
        const results = await Promise.allSettled(lanes.flatMap((lane, index) => lane.session && !lane.pending ? [enqueue(index, async (current, signal) => current.session?.keepAlive(signal), AbortSignal.timeout(40_000))] : []));
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
    lane.session ??= await openColabSession("production", lane.machine, jobSignal);
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
    const results = await Promise.allSettled([...[...strayColabSessions].map(async name => {
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
    const physicalIndex = colabLane(index);
    return Promise.resolve(poolReady).then(() => enqueue(physicalIndex, async (lane, jobSignal) => {
      const enteredAt = performance.now();
      const reused = !!lane.session;
      let readyAt: number | undefined;
      let passed = false;
      try {
        if (!lane.session) lane.closedAt = undefined;
        lane.session ??= await openColabSession(provider, lane.machine, jobSignal);
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
        if (!(error instanceof ColabConnectionError) && (!(error instanceof ColabScriptError) || error.unsafe) && lane.session) {
          const session = lane.session;
          lane.capacity = undefined;
          lane.prepared.clear();
          generation++;
          try { await session.reset(); } catch (resetError) {
            if ((await readColabSessionStatus(session.name)).state !== "off") throw new Error(`${error instanceof Error ? error.message : error}; restarting the kernel of ${session.name} also failed (${resetError instanceof Error ? resetError.message : resetError}), and the machine was left running`, { cause: error });
            await session.close(error);
            lane.closedAt = new Date().toISOString();
            lane.session = undefined;
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
    }, signal));
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
