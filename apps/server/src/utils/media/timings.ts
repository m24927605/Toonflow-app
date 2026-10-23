import { dirname, join } from "node:path";
import { readFile, writeAtomic } from "@toonflow/file";
import { z } from "zod";
import conf from "@/utils/conf";

export const machineCapacitySchema = z.object({
  checkedAt: z.string().datetime({ offset: true }), gpu: z.string().min(1),
  ramTotal: z.number().finite().positive(), ramAvailable: z.number().finite().nonnegative(),
  diskTotal: z.number().finite().positive(), diskFree: z.number().finite().nonnegative(),
}).refine(value => value.ramAvailable <= value.ramTotal && value.diskFree <= value.diskTotal, "Invalid machine capacity snapshot");

export const modelPreparationTimingSchema = z.object({
  name: z.string().min(1),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  seconds: z.number().finite().nonnegative(),
  passed: z.boolean(),
  gpuDeferred: z.boolean().optional(),
  capacity: machineCapacitySchema.optional(),
  details: z.object({
    phases: z.array(z.object({ name: z.string().min(1).max(80), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), seconds: z.number().finite().nonnegative() })).max(100),
    events: z.array(z.string().max(2000)).max(200),
  }).optional(),
});

const sampleSchema = z.object({
  at: z.string().datetime({ offset: true }),
  role: z.string().min(1).max(80),
  phase: z.enum(["allocation", "download", "load", "job", "queue", "upload", "output", "readiness"]),
  gpu: z.enum(["L4", "A100"]),
  seconds: z.number().finite().nonnegative(),
  passed: z.boolean(),
});
type Sample = z.infer<typeof sampleSchema>;
const path = () => join(dirname(conf.path), "colabTimings.json");
let queue: Promise<unknown> = Promise.resolve();

async function readSamples() {
  return readFile(path(), "utf8").then(text => z.array(sampleSchema).max(1000).parse(JSON.parse(text)), (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [] as Sample[];
  });
}

/** Retain observations, including failures, without allowing telemetry to fail a production. */
export function recordColabTiming(input: Omit<Sample, "at"> & { at?: string }) {
  const sample = sampleSchema.parse({ at: new Date().toISOString(), ...input });
  const next = queue.then(async () => {
    const samples = await readSamples();
    await writeAtomic(path(), JSON.stringify([...samples, sample].slice(-1000)));
  }).catch(error => console.error("[colabTiming] Could not persist observation:", error));
  queue = next;
  return next;
}

/** Recent observations are estimates, never a claim that hardware is currently available. */
export async function readColabTimings() {
  await queue;
  const recent = (await readSamples()).filter(sample => Date.now() - Date.parse(sample.at) <= 14 * 86_400_000);
  return [...Map.groupBy(recent, item => `${item.phase === "allocation" ? "hardware" : item.role}/${item.phase}/${item.gpu}`)].map(([key, samples]) => {
    const successful = samples.filter(item => item.passed).map(item => item.seconds).sort((a, b) => a - b);
    return { key, samples: samples.length, failures: samples.filter(item => !item.passed).length, medianSeconds: successful.length ? successful[Math.floor(successful.length / 2)] : null, latestAt: samples.at(-1)!.at };
  });
}
