import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({ name: z.string().min(1).max(1024), path: z.string().min(1).max(1024) }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please add skill files locally on the server", null, 403));
  const { name, path } = req.body as { name: string; path: string };
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    const target = await u.skillFile.resolveNewFile(name, path);
    try { await u.workspaceFile.writeWorkspaceFile(target, "", true); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return res.status(409).json(error("A file or directory with the same name already exists", null, 409));
      throw err;
    }
    res.json(success(null, "file created"));
  } finally { release(); }
});
