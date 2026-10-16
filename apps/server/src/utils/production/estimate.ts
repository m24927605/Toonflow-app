import { dirname, resolve } from "node:path";
import { readFile, writeAtomic } from "@toonflow/file";
import conf from "@/utils/conf";
import type { ProductionInput } from "./state";

// Finished productions' estimates and what they spent, kept with the settings.
const costsPath = () => resolve(dirname(conf.path), "productionCosts.json");
type ProductionCost = { at: string; estimate: number; actual: number };
const readCosts = () => readFile(costsPath(), "utf8").then(text => JSON.parse(text) as ProductionCost[], () => [] as ProductionCost[]);

/**
 * How far finished productions spent from their estimates: the median ratio, kept within 0.5–2 so one odd run cannot
 * swing every quote; 1 until a production has finished.
 */
export async function costRatio() {
  const ratios = (await readCosts()).filter(item => item.estimate > 0 && item.actual > 0).map(item => item.actual / item.estimate).sort((a, b) => a - b);
  return ratios.length ? Math.min(2, Math.max(0.5, ratios[Math.floor(ratios.length / 2)]!)) : 1;
}

/** Keeps a finished production's estimate and spend, so later estimates follow what productions really cost. */
export async function recordProductionCost(estimate: number, actual: number) {
  await writeAtomic(costsPath(), JSON.stringify([...await readCosts(), { at: new Date().toISOString(), estimate, actual }], null, 2));
}

// Compute units per hour measured with `colab usage` on 2026-10-15.
const a100 = 6.77;
const l4 = 1.54;
const hours = (minutes: number) => minutes / 60;

/**
 * The compute units a whole production is expected to use, per step, from its length and cast; `reusedPeople` people
 * already have their LoRAs, which the production reuses instead of training, and `ratio` is costRatio. ACT: Rough
 * per-step minutes (machine start plus per-item time) measured on a few runs, scaled by what finished productions
 * really spent; the language model steps assume one L4 kept warm.
 */
export function estimateProduction(input: Pick<ProductionInput, "seconds" | "quality" | "photos">, reusedPeople = 0, ratio = 1) {
  const shots = Math.ceil(input.seconds / 4);
  const people = Math.max(input.photos.length, 2);
  const trainedPeople = people - reusedPeople;
  const places = 1 + Math.floor(input.seconds / 60);
  const clipMinutes = { "480p": 10 + shots * 1.5, "720p": 10 + shots * 2.8, "1080p": 35 + shots * 6 }[input.quality];
  const steps = [
    { step: "text", units: l4 * hours(30) },
    { step: "assets", units: a100 * hours(5 + 0.5 * (people * 6 + places * 3)) },
    { step: "loras", units: l4 * (trainedPeople * 2 + places) + a100 * hours((trainedPeople + places) * (5 + 0.5 * 12)) },
    // Two images a shot: the draft and its redraw.
    { step: "keyframes", units: a100 * hours(5 + 0.5 * shots * 2) },
    { step: "clips", units: a100 * hours(clipMinutes) },
  ].map(item => ({ ...item, units: Number((item.units * 1.3 * ratio).toFixed(2)) }));
  return { shots, steps, total: Number(steps.reduce((sum, item) => sum + item.units, 0).toFixed(2)) };
}
