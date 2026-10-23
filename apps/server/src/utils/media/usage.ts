import { dirname, join } from "node:path";
import { readFile, readFileSync, writeAtomic, writeAtomicSync } from "@toonflow/file";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";

type BudgetModel = { id: string; label: string; imageSizes?: unknown; durationResolutionMap?: unknown };
type Ledger = { date: string; providers: Record<string, { count: number; units: number }>; triedModels: string[] };

const ledgerPath = () => join(dirname(conf.path), "mediaUsage.json");
const today = () => new Date().toLocaleDateString("sv-SE");
// ACT: One in-process queue keeps read-modify-write updates of the ledger ordered; the server is single-process.
let queue: Promise<unknown> = Promise.resolve();

async function readLedger(): Promise<Ledger> {
  const stored = await readFile(ledgerPath(), "utf8").then(text => JSON.parse(text) as Ledger, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  // Spending resets every day; the list of models that passed a trial run is kept.
  return { date: today(), providers: stored?.date === today() ? stored.providers : {}, triedModels: stored?.triedModels ?? [] };
}

function update(change: (ledger: Ledger) => void) {
  const next = queue.then(async () => {
    const ledger = await readLedger();
    change(ledger);
    await writeAtomic(ledgerPath(), JSON.stringify(ledger, null, 2));
  });
  queue = next.catch(() => {});
  return next;
}

function providerConfig(providerId: string) {
  const configs = conf.get("settings", {}).mediaProviderConfigs as Record<string, Record<string, unknown>> | undefined;
  return configs?.[providerId] ?? {};
}

function limit(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function rejected(message: string): never {
  throw Object.assign(new Error(message), { status: 429 });
}

/**
 * Enforces the provider's daily generation cap and the first-run trial: the first request for a model must be small
 * (the smallest image size, or a short low-resolution video) so a new model is checked cheaply before real runs.
 */
export function reserveGeneration(providerId: string, model: BudgetModel, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest) {
  return update(ledger => {
    const used = ledger.providers[providerId]?.count ?? 0;
    const cap = limit(providerConfig(providerId).dailyLimit);
    if (cap !== undefined && used >= cap) rejected(`Daily generation limit reached for ${providerId} (${used}/${cap}); raise it in the media model settings or wait until tomorrow`);
    if (!ledger.triedModels.includes(`${providerId}/${model.id}`) && mediaType !== "audio") {
      const sizes = Array.isArray(model.imageSizes) ? model.imageSizes as string[] : [];
      const durations = Array.isArray(model.durationResolutionMap) ? model.durationResolutionMap as { duration: number[]; resolution: string[] }[] : [];
      const smallestSize = sizes[0];
      if (mediaType === "image" && smallestSize && request.size && request.size !== smallestSize) {
        rejected(`First run of ${model.label}: send one ${smallestSize} trial image before larger sizes`);
      }
      if (mediaType === "video") {
        const shortest = durations.length ? Math.min(...durations.flatMap(entry => entry.duration)) : 5;
        const lowest = durations[0]?.resolution[0];
        if ((request.duration ?? 0) > Math.max(5, shortest) || (lowest && request.resolution && request.resolution !== lowest)) {
          rejected(`First run of ${model.label}: send one trial of at most ${Math.max(5, shortest)} s${lowest ? ` at ${lowest}` : ""} before longer or sharper runs`);
        }
      }
    }
    // A dispatched request can bill even when it fails or the server exits, so attempts reserve a durable daily slot.
    (ledger.providers[providerId] ??= { count: 0, units: 0 }).count += 1;
  });
}

/** Marks a successfully finished model as trialled; its daily slot was reserved before dispatch. */
export function recordGeneration(providerId: string, modelId: string) {
  return update(ledger => {
    if (!ledger.triedModels.includes(`${providerId}/${modelId}`)) ledger.triedModels.push(`${providerId}/${modelId}`);
  });
}

/** Refuses to start another Colab session once the provider's measured compute units for today reach its cap. */
export async function checkColabBudget(providerId: string) {
  const cap = limit(providerConfig(providerId).dailyComputeUnits);
  if (cap === undefined) return;
  const units = (await readLedger()).providers[providerId]?.units ?? 0;
  if (units >= cap) rejected(`Daily Colab compute unit limit reached for ${providerId} (${units.toFixed(2)}/${cap}); raise it in the media model settings or wait until tomorrow`);
}

export function recordColabUnits(providerId: string, units: number) {
  return update(ledger => {
    (ledger.providers[providerId] ??= { count: 0, units: 0 }).units += units;
  });
}

// The compute units this server's Colab sessions have used: `units` up to `at`, and since then `rate` an hour, the sum
// of the sessions open.
const meterPath = () => join(dirname(conf.path), "colabMeter.json");
type Meter = { units: number; rate: number; at: number };

function readMeter(): Meter {
  try {
    return JSON.parse(readFileSync(meterPath(), "utf8")) as Meter;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { units: 0, rate: 0, at: Date.now() };
    throw error;
  }
}

const unitsSince = (meter: Meter, longest = Infinity) => meter.units + meter.rate * Math.max(0, Math.min(Date.now() - meter.at, longest)) / 3_600_000;

/**
 * Meters the Colab sessions as they open and stop: the units at the old rate are added and `rate`, the hourly rate of
 * the sessions open now, runs on. A session counts the moment it runs, while the account balance shows its units only
 * minutes after it ends. Synchronous, so the exit handler that stops every session can call it; `longest` caps the
 * time counted at the old rate.
 */
export function meterColab(rate: number, longest?: number) {
  writeAtomicSync(meterPath(), JSON.stringify({ units: unitsSince(readMeter(), longest), rate, at: Date.now() }));
}

/** The compute units metered so far, with the sessions still open counted up to now. */
export const meteredColabUnits = () => unitsSince(readMeter());
