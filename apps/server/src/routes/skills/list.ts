import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({ name: z.string().min(1).max(1024) }, "query"), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please view skill files locally on the server", null, 403));
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    const { mainPath, files } = await u.skillFile.list(req.query.name as string);
    res.set("Cache-Control", "no-store").json(success({ mainPath, files }));
  } finally { release(); }
});
