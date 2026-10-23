import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  id: z.string().uuid(), action: z.enum(["retry", "clarify"]), message: z.string().trim().min(1).max(2000).optional(),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const cwd = await u.workspace.resolveWorkspace(req, await u.production.simpleWorkspaceDirectory());
  await u.production.resolveSimpleProduction(cwd, req.body.id, req.body.action, req.body.message?.trim());
  res.json(success({ id: req.body.id }));
});
