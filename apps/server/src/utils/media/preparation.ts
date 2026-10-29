import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readFile, readdir, rm, stat, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";
import type { ColabSession } from "./colab";
import { colabLane, colabSessionName, createColabWorker, rememberColabCapacity, useExistingColabSession, type ColabPreparation } from "./colabPool";
import cacheScript from "./runtimeCache.py" with { type: "text" };
import pythonDependencies from "./pythonDependencies.json";
import installerSource from "./modelPreparation.py" with { type: "text" };
import { machineCapacitySchema, modelPreparationTimingSchema, recordColabTiming } from "./timings";

const cacheDirectory = () => join(dirname(conf.path), "colabCache");
const manifestSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(["install", "compile"]), sha256: z.string().regex(/^[a-f0-9]{64}$/), identity: z.object({ source: z.string(), hardware: z.string(), python: z.string(), cudaToolkit: z.string().nullable() }), included: z.array(z.object({ phase: z.enum(["install", "compile"]), path: z.string(), bytes: z.number().nonnegative() })), skipped: z.array(z.object({ path: z.string(), bytes: z.number().nonnegative(), reason: z.string() })), environment: z.record(z.string(), z.unknown()) });
const pendingCaches = new Map<string, { sessionName: string; lane: number; spec: string; phase: "install" | "compile" }>();
const ownersPath = () => join(dirname(conf.path), "pendingModelCaches.json");
let ownersLoaded: Promise<void> | undefined;
let ownersQueue: Promise<unknown> = Promise.resolve();
const saveOwners = () => {
  const next = ownersQueue.then(() => writeAtomic(ownersPath(), JSON.stringify([...pendingCaches.values()])));
  ownersQueue = next.catch(() => {});
  return next;
};

export async function registerModelCaches(lane: number, items: ColabPreparation[]) {
  ownersLoaded ??= readFile(ownersPath(), "utf8").then(text => {
    const saved = z.array(z.strictObject({ sessionName: z.string().regex(/^toonflow-[0-9a-f]{8}$/), lane: z.number().int().min(0).max(3), spec: z.string().min(1), phase: z.enum(["install", "compile"]) })).max(128).parse(JSON.parse(text));
    for (const item of saved) if (colabSessionName(item.lane) === item.sessionName) pendingCaches.set(`${item.sessionName}:${item.phase}:${JSON.parse(item.spec)[item.phase + "Source"]}`, item);
  }, (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await ownersLoaded;
  for (const [key, item] of pendingCaches) if (colabSessionName(item.lane) !== item.sessionName) pendingCaches.delete(key);
  const sessionName = colabSessionName(colabLane(lane));
  if (!sessionName || items.every(item => item.name === "text")) return;
  const installSpecs = [...Map.groupBy(items, item => item.installSource).values()].map(preparationCacheSpec);
  const compileSpecs = items.map(item => preparationCacheSpec([item]));
  for (const [phase, specs] of [["install", installSpecs], ["compile", compileSpecs]] as const) for (const spec of specs) pendingCaches.set(`${sessionName}:${phase}:${JSON.parse(spec)[phase + "Source"]}`, { sessionName, lane: colabLane(lane), spec, phase });
  await saveOwners();
}

const nativeRoot = "/content/toonflowCache";
export const preparationKey = (item: ColabPreparation) => `${item.name}:${createHash("sha256").update(JSON.stringify([item, pythonDependencies, installerSource])).digest("hex").slice(0, 16)}`;
// Scheduling hints do not change installed artifacts or compiler compatibility.
export const preparationCacheSpec = (items: ColabPreparation[]) => JSON.stringify({
  installSource: createHash("sha256").update(JSON.stringify([1, [...new Set(items.map(item => item.installSource))].sort(), pythonDependencies])).digest("hex"),
  compileSource: createHash("sha256").update(JSON.stringify([items.map(({ name, runtime, job }) => ({ name, runtime, job })), pythonDependencies, cacheScript])).digest("hex"),
  installSources: [...new Set(items.map(item => item.installSource))].sort(),
  runtimes: items.map(item => item.runtime),
});

async function cacheJob(session: ColabSession, spec: string, phase: "install" | "compile", action: string, signal: AbortSignal, outputs: string[] = []) {
  return session.job({ script: cacheScript, uploads: [{ name: "cacheSpec.json", data: spec }], env: { TOONFLOW_CACHE_SPEC: "cacheSpec.json", TOONFLOW_CACHE_PHASE: phase, TOONFLOW_CACHE_ACTION: action }, outputs }, signal);
}

async function cacheUploads(spec: string, phase: "install" | "compile") {
  const source = JSON.parse(spec)[`${phase}Source`];
  const names = await readdir(cacheDirectory()).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return []; });
  const specName = `${phase}${source}Spec.json`;
  const uploads: { name: string; data: string | Uint8Array }[] = [{ name: specName, data: spec }];
  const candidates: { key: string; manifest: string; archive: string }[] = [];
  for (const name of names.filter(name => new RegExp(`^${phase}[a-f0-9]{64}\\.json$`).test(name))) {
    const saved = await readFile(join(cacheDirectory(), name), "utf8");
    let decoded: unknown;
    try { decoded = JSON.parse(saved); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await rm(join(cacheDirectory(), name));
      await rm(join(cacheDirectory(), name.replace(/\.json$/, ".tar.gz")), { force: true });
      continue;
    }
    const parsed = manifestSchema.safeParse(decoded);
    if (!parsed.success) continue;
    const manifest = parsed.data;
    if (manifest.phase !== phase || manifest.identity.source !== source || !manifest.included.some(item => item.bytes > 0)) continue;
    const data = await readFile(join(cacheDirectory(), `${phase}${manifest.key}.tar.gz`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!data || createHash("sha256").update(data).digest("hex") !== manifest.sha256) {
      await rm(join(cacheDirectory(), name), { force: true });
      await rm(join(cacheDirectory(), name.replace(/\.json$/, ".tar.gz")), { force: true });
      continue;
    }
    const candidate = { key: manifest.key, manifest: `${phase}${manifest.key}Manifest.json`, archive: `${phase}${manifest.key}Artifacts.tar.gz` };
    candidates.push(candidate);
    uploads.push({ name: candidate.manifest, data: saved }, { name: candidate.archive, data });
  }
  return { configuration: { source, phase, spec: specName, candidates }, uploads };
}

/** CPU preparation runs outside the GPU FIFO; each ready model loads and publishes its own checkpoint. */
export async function prepareModels(lane: number, preparations: ColabPreparation[], signal: AbortSignal, completed: (timing: z.infer<typeof modelPreparationTimingSchema>) => Promise<void>) {
  const worker = createColabWorker("modelPreparation", lane);
  const batch = crypto.randomUUID();
  const requestFile = "prepare" + batch + ".json";
  const statusFile = "/content/prepare" + batch + "Status.json";
  const cancelFile = "/content/prepare" + batch + "Cancelled";
  const installGroups = [...Map.groupBy(preparations, item => item.installSource).values()];
  const installs = await Promise.all(installGroups.map(items => cacheUploads(preparationCacheSpec(items), "install")));
  const compilers = await Promise.all(preparations.map(item => cacheUploads(preparationCacheSpec([item]), "compile")));
  const models = preparations.map((item, index) => ({ name: item.name, key: preparationKey(item), runtime: item.runtime, script: item.job.script, env: item.job.env, timingOutput: item.timingOutput, prefetch: !!item.prefetch, installSource: JSON.parse(preparationCacheSpec(installGroups.find(group => group[0]!.installSource === item.installSource)!)).installSource, compileCache: compilers[index]!.configuration }));
  const request = { batch, models, installCaches: installs.map(item => item.configuration) };
  const session = await worker.run(async (session, jobSignal) => {
    await session.job({
      script: `import json, subprocess, sys, time\nfrom pathlib import Path\nrequest = json.loads(Path('/content/${requestFile}').read_text())\nPath(${JSON.stringify(statusFile)}).write_text(json.dumps({'batch': request['batch'], 'updatedAt': time.time(), 'models': {item['name']: {'key': item['key'], 'state': 'preparing'} for item in request['models']}}))\nlog = open('/content/prepare${batch}.log', 'ab')\nsubprocess.Popen([sys.executable, '/content/toonflowRuntime.py', 'prepare', '/content/${requestFile}', ${JSON.stringify(statusFile)}, ${JSON.stringify(cancelFile)}], stdout=log, stderr=log, start_new_session=True)\nprint('COLAB_DONE')\n`,
      uploads: [{ name: requestFile, data: JSON.stringify(request) }, { name: "runtimeCache.py", data: cacheScript }, ...preparations.flatMap(item => item.job.uploads), ...installs.flatMap(item => item.uploads), ...compilers.flatMap(item => item.uploads)], env: {}, outputs: [], runtime: "modelPreparation",
    }, jobSignal);
    await registerModelCaches(lane, preparations);
    return session;
  }, signal);
  const pending = new Map(preparations.map(item => [item.name, item]));
  const deadline = performance.now() + 30 * 60_000;
  const packetSchema = z.object({ batch: z.literal(batch), updatedAt: z.number().positive(), error: z.string().optional(), models: z.record(z.string(), z.object({ key: z.string(), state: z.enum(["preparing", "ready", "failed"]), error: z.string().optional(), result: modelPreparationTimingSchema.optional() })) });
  try {
    while (pending.size) {
      signal.throwIfAborted();
      const packet = packetSchema.parse(JSON.parse(Buffer.from(await session.readOutput(statusFile, signal)).toString("utf8")));
      if (Date.now() / 1000 - packet.updatedAt > 120 || performance.now() > deadline) throw new Error(`Model preparation stopped reporting progress or exceeded 30 minutes: /content/prepare${batch}.log`);
      if (packet.error) throw new Error(packet.error);
      let changed = false;
      for (const [name, item] of pending) {
        const status = packet.models[name];
        if (!status || status.key !== preparationKey(item)) throw new Error(`Preparation result does not match ${name}`);
        if (status.state === "failed") throw new Error(status.error || `${name} preparation failed`);
        if (status.state !== "ready") continue;
        const timing = modelPreparationTimingSchema.parse(status.result);
        if (timing.name !== name || !timing.passed || !timing.capacity) throw new Error(`Incomplete preparation result for ${name}`);
        await recordColabTiming({ role: item.name, phase: "download", gpu: lane === 0 ? "L4" : "A100", seconds: timing.seconds, passed: true });
        await completed({ ...timing, name: name + "Download" });
        if (timing.capacity) await rememberColabCapacity(colabLane(lane), session.name, timing.capacity);
        const start = new Date().toISOString(), began = performance.now();
        if (item.deferLoad) {
          await completed({ name, start, end: start, seconds: 0, passed: true, gpuDeferred: true, capacity: timing.capacity });
        } else {
          let passed = false;
          let details: z.infer<typeof modelPreparationTimingSchema>["details"];
          let capacity: z.infer<typeof machineCapacitySchema> | undefined;
          try {
            const output = `/content/${batch}${name}Loaded.json`;
            const script = item.job.script + `\nimport json as _preparationJson\nfrom pathlib import Path as _preparationPath\nfrom modelPreparation import readCapacity as _readCapacity\n_preparationDetails = ${item.timingOutput ? `_preparationJson.loads(_preparationPath(${JSON.stringify(item.timingOutput)}).read_text())` : "{'phases': [], 'events': []}"}\n_preparationPath(${JSON.stringify(output)}).write_text(_preparationJson.dumps({'details': _preparationDetails, 'capacity': _readCapacity()}))\nprint('COLAB_DONE')\n`;
            const [data] = await worker.run((current, jobSignal) => current.job({ ...item.job, script, outputs: [output], runtime: item.runtime }, jobSignal), signal);
            const loaded = z.object({ details: modelPreparationTimingSchema.shape.details, capacity: machineCapacitySchema }).parse(JSON.parse(Buffer.from(data!).toString("utf8")));
            details = { phases: loaded.details?.phases ?? [], events: [...loaded.details?.events ?? [], ...timing.details?.events ?? []] };
            capacity = loaded.capacity;
            await rememberColabCapacity(colabLane(lane), session.name, capacity);
            passed = true;
          } finally {
            const seconds = (performance.now() - began) / 1000;
            await recordColabTiming({ role: item.name, phase: "load", gpu: lane === 0 ? "L4" : "A100", seconds, passed });
            await completed({ name, start, end: new Date().toISOString(), seconds, passed, details, capacity });
          }
        }
        pending.delete(name);
        changed = true;
      }
      if (pending.size && !changed) await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(done, 2000);
        function done() { signal.removeEventListener("abort", abort); resolve(); }
        function abort() { clearTimeout(timeout); signal.removeEventListener("abort", abort); reject(signal.reason); }
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } finally {
    if (pending.size || signal.aborted) await session.writeInput(cancelFile.slice("/content/".length), "cancelled", AbortSignal.timeout(30_000)).catch(error => console.error("[colabPreparation] Cancellation marker failed:", error));
  }
}

/** Snapshot once before a controlled shutdown; cache work never allocates a new VM. */
export async function saveModelCaches(signal: AbortSignal) {
  const tasks = [...pendingCaches.values()];
  await mkdir(cacheDirectory(), { recursive: true });
  const groups = Map.groupBy(tasks, item => item.sessionName);
  const results = await Promise.allSettled([...groups.values()].map(group => useExistingColabSession(group[0]!.lane, group[0]!.sessionName, async (session, jobSignal) => { for (const { spec, phase } of group) {
    const began = performance.now();
    const [manifestData, data] = await cacheJob(session, spec, phase, "save", jobSignal, [`${nativeRoot}/${phase}Manifest.json`, `${nativeRoot}/${phase}Artifacts.tar.gz`]);
    const manifest = manifestSchema.parse(JSON.parse(Buffer.from(manifestData!).toString("utf8")));
    if (createHash("sha256").update(data!).digest("hex") !== manifest.sha256) throw new Error("Downloaded runtime cache digest mismatch");
    if (!manifest.included.some(item => item.bytes > 0)) {
      console.log("[colabCache]", JSON.stringify({ session: session.name, phase, skippedEmpty: true, skipped: manifest.skipped }));
      pendingCaches.delete(`${session.name}:${phase}:${JSON.parse(spec)[phase + "Source"]}`);
      await saveOwners();
      continue;
    }
    await writeAtomic(join(cacheDirectory(), `${phase}${manifest.key}.tar.gz`), data!);
    await writeAtomic(join(cacheDirectory(), `${phase}${manifest.key}.json`), manifestData!);
    pendingCaches.delete(`${session.name}:${phase}:${JSON.parse(spec)[phase + "Source"]}`);
    await saveOwners();
    console.log("[colabCache]", JSON.stringify({ session: session.name, phase, bytes: data!.length, seconds: (performance.now() - began) / 1000, included: manifest.included, skipped: manifest.skipped }));
  } }, signal)));
  for (const result of results) if (result.status === "rejected") console.error("[colabCache] Snapshot failed:", result.reason);
  const entries = await Promise.all((await readdir(cacheDirectory())).filter(name => name.endsWith(".tar.gz")).map(async name => ({ name, ...(await stat(join(cacheDirectory(), name))) })));
  let total = entries.reduce((sum, item) => sum + item.size, 0);
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= 4 * 1024 ** 3) break;
    await rm(join(cacheDirectory(), entry.name));
    await rm(join(cacheDirectory(), entry.name.replace(/\.tar\.gz$/, ".json")), { force: true });
    total -= entry.size;
  }
}
