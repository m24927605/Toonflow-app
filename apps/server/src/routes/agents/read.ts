import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ name: z.string().regex(u.teams.teamNamePattern) }, "query"), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please read team files locally on the server", null, 403));
  res.json(success(await u.teams.readEditableTeam(req.query.name as string)));
});
