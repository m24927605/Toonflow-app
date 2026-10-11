import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();
const maxBytes = 20 * 1024 * 1024;

export default router.post("/", validateFields({
  fileName: z.string().max(128).optional(),
  source: z.string().max(maxBytes).optional(),
  url: z.string().url().max(4096).optional(),
  force: z.boolean().optional(),
}), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please install the node locally on the server", null, 403));
  const { fileName, source, url, force } = req.body as { fileName?: string; source?: string; url?: string; force?: boolean };
  if (url ? source !== undefined : fileName === undefined || source === undefined) {
    return res.status(400).json(error("Please select a file or fill in the remote address", null, 400));
  }

  const result = url
    ? await u.pluginInstall.installRemotePlugin("node", url, fileName, force)
    : await u.pluginInstall.installNode(fileName!, source!, force);
  res.json(success(result, "Node is installed"));
});
