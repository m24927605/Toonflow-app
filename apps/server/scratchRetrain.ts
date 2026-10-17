// Scratch: retrains the two character H3 LoRAs with the committed recipe; deleted after the run.
import { readFileSync } from "node:fs";
import { trainLora } from "@/utils/media/lora";
import { assetViews } from "@/utils/production/assets";
const cwd = "/Users/sin-chengchen/video/japan-women-test-A";
const production = JSON.parse(readFileSync(`${cwd}/productions/4cf99666-b3d8-4a00-9a13-37dda36d6802/production.json`, "utf8"));
const started = Date.now();
const results = await Promise.allSettled(production.assets.characters.map(async (item: Parameters<typeof assetViews>[0]) => {
  const records = await trainLora(cwd, { kind: "character", families: ["h3"], name: item.name, items: assetViews(item).map(path => ({ path })) });
  console.log(`[retrain] ${item.name} done after ${Math.round((Date.now() - started) / 60000)} min:`, JSON.stringify(records));
}));
for (const result of results) if (result.status === "rejected") console.log("[retrain] failed:", result.reason);
process.exit(0);
