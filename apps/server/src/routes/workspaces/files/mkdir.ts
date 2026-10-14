import { lstat, mkdir } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096) }), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  // An existing folder is reported as EEXIST without taking the lock: creating it changes nothing, and nodes that
  // create "assets" while another node creates "assets/<id>" would otherwise fail with a busy lock.
  if ((await lstat(path).catch(() => null))?.isDirectory()) throw Object.assign(new Error("Folder already exists"), { code: "EEXIST" });
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try { await mkdir(path); }
  finally { release(); }
  res.json(success());
});
