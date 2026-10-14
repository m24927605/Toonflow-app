import type { ProductionInput } from "./state";

// Compute units per hour measured with `colab usage` on 2026-10-15.
const a100 = 6.77;
const l4 = 1.54;
const hours = (minutes: number) => minutes / 60;

/**
 * The compute units a whole production is expected to use, per step, from its length and cast. ACT: Rough per-step
 * minutes (machine start plus per-item time) measured on a few runs; the language model steps assume one L4 kept warm.
 * Recalibrate these once full productions have run, from their recorded spend.
 */
export function estimateProduction(input: Pick<ProductionInput, "seconds" | "quality" | "photos">) {
  const shots = Math.ceil(input.seconds / 4);
  const people = Math.max(input.photos.length, 2);
  const places = 1 + Math.floor(input.seconds / 60);
  const finalMinutes = { "480p": 0, "720p": 10 + shots * 2.8, "1080p": 35 + shots * 6 }[input.quality];
  const steps = [
    { step: "text", units: l4 * hours(30) },
    { step: "assets", units: a100 * hours(5 + 0.5 * (people * 6 + places * 3)) },
    { step: "loras", units: l4 * (people * 2 + places) + a100 * hours((people + places) * (5 + 0.5 * 12)) },
    { step: "keyframes", units: a100 * hours(5 + 0.5 * shots) },
    { step: "roughCut", units: a100 * hours(10 + shots * 1.5) },
    { step: "final", units: a100 * hours(finalMinutes) },
  ].map(item => ({ ...item, units: Number((item.units * 1.3).toFixed(2)) }));
  return { shots, steps, total: Number(steps.reduce((sum, item) => sum + item.units, 0).toFixed(2)) };
}
