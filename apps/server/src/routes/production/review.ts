import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  notes: z.string().trim().max(5000).optional(),
  script: z.string().max(200000).optional(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { directory, id, notes, script } = req.body as { directory: string; id: string; notes?: string; script?: string };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  await u.production.reviewProduction(cwd, id, { notes: notes?.trim() || undefined, script });
  res.json(success());
});
