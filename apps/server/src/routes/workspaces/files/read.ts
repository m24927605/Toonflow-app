import { lstat, readFile } from "@toonflow/file";
import { createHash } from "node:crypto";
import { sendFile } from "@/utils/fileHttp";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096), snapshot: z.enum(["true"]).optional(), maxBytes: z.coerce.number().int().positive().max(20 * 1024 * 1024).optional() }, "query"), async (req, res, next) => {
  const { path } = await u.workspaceFile.resolveWorkspaceFile(req, req.query.directory as string, req.query.path as string);
  const file = await lstat(path);
  if (!file.isFile()) throw Object.assign(new Error("can only read files"), { status: 400 });
  res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
  if (req.query.snapshot === "true") {
    const maxBytes = req.query.maxBytes === undefined ? undefined : Number(req.query.maxBytes);
    if (maxBytes !== undefined && file.size > maxBytes) throw Object.assign(new Error("The file exceeds the size limit for this text read"), { status: 413 });
    const bytes = await readFile(path);
    if (maxBytes !== undefined && bytes.length > maxBytes) throw Object.assign(new Error("The file exceeds the size limit for this text read"), { status: 413 });
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
        : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? "utf-8-bom" : "utf-8";
    let text: string;
    try {
      text = new TextDecoder(encoding === "utf-8-bom" ? "utf-8" : encoding, { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("binary");
    } catch {
      throw Object.assign(new Error("This file is neither supported UTF-8 text nor UTF-16 text with a BOM. Convert its encoding in the original editor before opening it again. The original file has not been modified"), { status: 415 });
    }
    res.json(success({ text, encoding, revision: createHash("sha256").update(bytes).digest("hex") }));
    return;
  }
  await sendFile(res, path, { dotfiles: "allow" }, err => { if (err) next(err); });
});
