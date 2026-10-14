import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import type { ProductionInput } from "@/utils/production";

export default Router().post("/", validateFields({
  seconds: z.number().int().min(10).max(600),
  quality: z.enum(u.production.productionQualities),
  people: z.number().int().min(0).max(20),
}), async (req, res) => {
  const { seconds, quality, people } = req.body as { seconds: number; quality: ProductionInput["quality"]; people: number };
  res.json(success(u.production.estimateProduction({ seconds, quality, photos: Array.from({ length: people }, () => ({ name: "", path: "" })) })));
});
