import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", validateFields({
  name: z.string().min(1).max(1024),
  order: z.array(z.string().min(1).max(1024)).max(2000),
}), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please reorder skill files locally on the server", null, 403));
  const { name, order } = req.body as { name: string; order: string[] };
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    await u.skillFile.saveOrder(name, order);
    res.json(success(null, "Order saved"));
  } finally { release(); }
});
