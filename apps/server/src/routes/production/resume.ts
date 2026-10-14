import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  budget: z.number().positive().max(1000).optional(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { directory, id, budget } = req.body as { directory: string; id: string; budget?: number };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  await u.production.resumeProduction(cwd, id, budget);
  res.json(success());
});
