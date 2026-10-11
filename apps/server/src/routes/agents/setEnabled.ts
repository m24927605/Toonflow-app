import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ name: z.string().regex(u.teams.teamNamePattern), enabled: z.boolean() }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please manage teams locally on the server", null, 403));
  await u.teams.setEnabled(req.body.name, req.body.enabled);
  res.json(success({ name: req.body.name, enabled: req.body.enabled }));
});
