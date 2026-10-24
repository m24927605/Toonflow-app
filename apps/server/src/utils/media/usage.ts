import { dirname, join } from "node:path";
import { readFile, readFileSync, writeAtomic, writeAtomicSync } from "@toonflow/file";
import conf from "@/utils/conf";

type Ledger = { date: string; providers: Record<string, { count: number; units: number }> };

const ledgerPath = () => join(dirname(conf.path), "mediaUsage.json");
const today = () => new Date().toLocaleDateString("sv-SE");
// ACT: One in-process queue keeps read-modify-write updates of the ledger ordered; the server is single-process.
let queue: Promise<unknown> = Promise.resolve();

async function readLedger(): Promise<Ledger> {
  const stored = await readFile(ledgerPath(), "utf8").then(text => JSON.parse(text) as Ledger, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  // Spending resets every day.
  return { date: today(), providers: stored?.date === today() ? stored.providers : {} };
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

/** Enforces the provider's daily generation cap. */
export function reserveGeneration(providerId: string) {
  return update(ledger => {
    const used = ledger.providers[providerId]?.count ?? 0;
    const cap = limit(providerConfig(providerId).dailyLimit);
    if (cap !== undefined && used >= cap) rejected(`Daily generation limit reached for ${providerId} (${used}/${cap}); raise it in the media model settings or wait until tomorrow`);
    // A dispatched request can bill even when it fails or the server exits, so attempts reserve a durable daily slot.
    (ledger.providers[providerId] ??= { count: 0, units: 0 }).count += 1;
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
