import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ id: z.uuid(), directory: z.string().min(1).max(4096) }), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  u.mediaJobs.cancelMediaJob(req.body.id, cwd);
  res.json(success());
});
