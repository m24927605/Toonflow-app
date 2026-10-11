import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ id: z.uuid(), directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, String(req.query.directory));
  const result = u.mediaJobs.readMediaJob(String(req.query.id), cwd);
  if (!result) {
    res.json(success({ done: false }));
    return;
  }
  if (result.code !== 200) {
    res.status(result.code >= 400 && result.code < 600 ? result.code : 500).json(result);
    return;
  }
  res.json(success({ done: true, files: result.data }));
});
