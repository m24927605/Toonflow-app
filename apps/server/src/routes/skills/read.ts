import { readFile } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({
  name: z.string().min(1).max(1024),
  path: z.string().min(1).max(1024).optional(),
}, "query"), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please read skills locally on the server", null, 403));
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    const { target } = await u.skillFile.locate(req.query.name as string, req.query.path as string | undefined);
    const bytes = await readFile(target);
    if (bytes.byteLength > u.skillFile.maxBytes) return res.status(413).json(error("Skill file cannot exceed 20 MB", null, 413));
    if (bytes.includes(0)) return res.status(400).json(error("The file is not text content and cannot be opened in an editor", null, 400));
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return res.status(400).json(error("The file is not valid UTF-8 text and cannot be opened in an editor", null, 400)); }
    res.set("Cache-Control", "no-store").json(success({ content }));
  } finally { release(); }
});