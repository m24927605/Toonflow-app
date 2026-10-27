import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

// The base prompt is the first trainer argument on its own, so a leading "-" would be read as an option.
const slider = z.strictObject({ base: z.string().trim().min(1).max(500).regex(/^[^-]/), positive: z.string().trim().min(1).max(200), negative: z.string().trim().min(1).max(200) });

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  kind: z.enum(u.lora.loraKinds),
  families: z.array(z.enum(["ltx", "qwen", "krea2"])).min(1).max(3).refine(list => new Set(list).size === list.length, "Each model family trains once"),
  name: z.string().trim().min(1).max(64),
  items: z.array(z.strictObject({ path: z.string().min(1).max(4096), caption: z.string().trim().min(1).max(2000).optional() })).max(200),
  slider: slider.optional(),
}), async (req, res) => {
  // Only Toonflow pages may spend the Colab plan.
  u.mcpControl.assertAppRequest(req);
  const { directory, kind, families, name, items, slider: ends } = req.body as Parameters<typeof u.lora.trainLora>[1] & { directory: string };
  // Characters and scenes are topped up with generated variants, so one image is enough to start.
  const minItems = kind === "character" || kind === "scene" ? 1 : 4;
  if (kind === "slider" ? !ends : items.length < minItems) {
    res.status(400).json(error(kind === "slider" ? "A slider needs its base prompt and its two ends" : `Training needs at least ${minItems} items`));
    return;
  }
  if (families.includes("qwen") && kind === "motion") {
    res.status(400).json(error("Qwen-Image learns from images only; train motion for Sulphur 2"));
    return;
  }
  if (families.includes("ltx") && kind === "slider") {
    res.status(400).json(error("Sliders train for Qwen-Image only"));
    return;
  }
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const input = { kind, families, name, items: items.map(({ path, caption }) => ({ path, ...caption ? { caption } : {} })), ...ends ? { slider: ends } : {} };
  // Training runs as a background job that the page polls like a generation. It saves its LoRAs to the workspace, so it
  // keeps running when the page closes instead of throwing away the paid work.
  res.json(success({ id: u.mediaJobs.startJob(cwd, signal => u.lora.trainLora(cwd, input, signal), false) }));
});
