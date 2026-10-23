import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import type { ProductionInput } from "@/utils/production";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  seconds: z.number().int().min(5).max(600),
  quality: z.enum(u.production.productionQualities),
  // One name per person the production keeps, as typed so far; an unnamed photo still counts as a person.
  names: z.array(z.string().trim().max(64)).max(20),
}), async (req, res) => {
  const { directory, seconds, quality, names } = req.body as { directory: string; seconds: number; quality: ProductionInput["quality"]; names: string[] };
  await u.workspace.resolveWorkspace(req, directory);
  res.json(success(await u.production.quoteProduction({ seconds, quality, photos: names.map(name => ({ name: name.trim(), path: "" })) })));
});
