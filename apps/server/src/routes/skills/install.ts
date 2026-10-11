import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();
const maxBytes = 20 * 1024 * 1024;

export default router.post("/", validateFields({
  fileName: z.string().max(128).optional(),
  base64: z.string().min(1).max(Math.ceil(maxBytes / 3) * 4).base64().optional(),
  url: z.string().url().max(4096).optional(),
  force: z.boolean().optional(),
}), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please install the skill locally on the server", null, 403));
  const { fileName, base64, url, force } = req.body as { fileName?: string; base64?: string; url?: string; force?: boolean };
  if (url ? base64 !== undefined : fileName === undefined || base64 === undefined) {
    return res.status(400).json(error("Please select a file or fill in the remote address", null, 400));
  }
  const result = url
    ? await u.pluginInstall.installRemotePlugin("skill", url, fileName, force)
    : await u.pluginInstall.installSkill(fileName!, Buffer.from(base64!, "base64"), force);
  res.json(success(result, "Skill has been installed"));
});
