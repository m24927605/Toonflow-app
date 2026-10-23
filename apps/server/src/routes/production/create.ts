import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import type { ProductionInput } from "@/utils/production";
import u from "@/utils";

const productionId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  id: productionId,
  outline: z.string().trim().min(1).max(20000),
  seconds: z.number().int().min(5).max(600),
  ratio: z.enum(u.production.productionRatios),
  quality: z.enum(u.production.productionQualities),
  budget: z.number().positive().max(1000),
  gates: z.array(z.enum(u.production.productionGates)).max(1),
  photos: z.array(z.strictObject({ name: z.string().trim().min(1).max(64), path: z.string().min(1).max(4096) })).max(20),
  subtitles: z.boolean(),
  music: z.boolean(),
  mode: z.literal("expert").optional(),
  modelRecipe: z.literal("sulphur2").optional(),
}), async (req, res) => {
  // Only Toonflow pages may spend the Colab plan.
  u.mcpControl.assertAppRequest(req);
  const { directory, id, ...input } = req.body as ProductionInput & { directory: string; id: string };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  // Photos are workspace files; resolving them here refuses paths outside the workspace before anything is spent.
  await Promise.all(input.photos.map(photo => u.workspaceFile.resolveWorkspacePath(cwd, photo.path)));
  const { outline, seconds, ratio, quality, budget, gates, photos, subtitles, music, modelRecipe } = input;
  try {
    await u.production.createProduction(cwd, id, { outline: outline.trim(), seconds, ratio, quality, budget, gates, photos, subtitles, music, modelRecipe });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    res.status(409).json(error("This node already has a production", undefined, 409));
    return;
  }
  res.json(success({ id }));
});
