import { Router } from "express";
import { z } from "zod";
import { readFile, stat } from "@toonflow/file";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  name: z.string().regex(/^(?=.*\S)[\p{L}\p{N}_. -]{1,64}$/u, "Character names can only contain letters, numbers, spaces, dots, hyphens and underscores, up to 64 characters."),
  kind: z.enum(["soul_2", "soul_cinematic"]),
  images: z.array(z.string().min(1).max(4096)).min(5).max(20),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { directory, name, kind, images } = req.body as { directory: string; name: string; kind: "soul_2" | "soul_cinematic"; images: string[] };
  const files = await Promise.all(images.map(async path => {
    const mimeType = imageTypes[path.split(".").at(-1)?.toLowerCase() ?? ""];
    if (!mimeType) throw Object.assign(new Error("Training images must be PNG, JPEG or WebP."), { status: 400 });
    const { path: file } = await u.workspaceFile.resolveWorkspaceFile(req, directory, path);
    if ((await stat(file)).size > 20 * 1024 * 1024) throw Object.assign(new Error("Each training image must be 20 MB or smaller."), { status: 400 });
    return { data: new Uint8Array(await readFile(file)), mimeType };
  }));
  res.json(success(await u.higgsfield.createSoul(name, kind, files)));
});
