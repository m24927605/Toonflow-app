import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ id: z.string().uuid(), messageId: z.string().uuid(), message: z.string().trim().min(1).max(20000), action: z.enum(["chat", "start"]), attachments: z.array(u.production.referenceAttachmentSchema).max(10).optional() }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const cwd = await u.workspace.resolveWorkspace(req, await u.production.simpleWorkspaceDirectory());
  await u.production.sendProductionMessage(cwd, req.body.id, req.body.messageId, req.body.message.trim(), req.body.action, req.body.attachments);
  res.json(success({ id: req.body.messageId }));
});
