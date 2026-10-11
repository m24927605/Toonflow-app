import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", validateFields({
  name: z.string().min(1).max(1024),
  path: z.string().min(1).max(1024).optional(),
  content: z.string(),
}), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please edit skills locally on the server", null, 403));
  const { name, path, content } = req.body as { name: string; path?: string; content: string };
  if (Buffer.byteLength(content, "utf8") > u.skillFile.maxBytes) return res.status(413).json(error("Skill file cannot exceed 20 MB", null, 413));
  if (content.includes("\u0000")) return res.status(400).json(error("content cannot contain null characters", null, 400));
  // ACT: Lock the skills root across scan and replace to avoid interleaving with
  // in-process installs/file operations; narrow the lock scope if concurrency grows.
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    const { target, isMain } = await u.skillFile.locate(name, path);
    if (isMain) {
      try {
        const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
        if (!/^---\n[\s\S]*?\n---(?:\n|$)/.test(normalized) || !/^---(?:\n|$)/.test(normalized.slice(normalized.indexOf("\n---", 3) + 1))) {
          throw new Error("frontmatter");
        }
        // The SDK uses yaml.parse and throws outward; do not re-serialize,
        // preserving the original text, comments and line breaks.
        const { frontmatter } = parseFrontmatter(content);
        z.object({ name: z.literal(name), description: z.string().max(1024).refine(value => Boolean(value.trim())) }).parse(frontmatter);
      } catch {
        return res.status(400).json(error("SKILL.md must contain valid YAML, the same string name as the original skill, and a non-empty description that does not exceed 1024 characters.", null, 400));
      }
    }
    await u.workspaceFile.writeWorkspaceFile(target, content);
    res.json(success(null, "Saved"));
  } finally { release(); }
});