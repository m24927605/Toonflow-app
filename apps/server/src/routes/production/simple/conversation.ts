import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ id: z.string().uuid() }, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, await u.production.simpleWorkspaceDirectory());
  const conversation = await u.production.getProductionConversation(cwd, String(req.query.id));
  res.set("Cache-Control", "no-store").json(success(conversation));
});
