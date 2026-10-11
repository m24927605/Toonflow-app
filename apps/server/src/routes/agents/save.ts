import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ name: z.string().regex(u.teams.teamNamePattern), path: z.string().min(1).max(1024), content: z.string() }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please edit team files locally on the server", null, 403));
  await u.teams.saveTeamFile(req.body.name, req.body.path, req.body.content);
  res.json(success(null, "Saved"));
});
