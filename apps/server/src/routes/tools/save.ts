import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", validateFields({ name: u.plugins.toolNameSchema, config: z.record(z.string(), z.json()) }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please manage tools locally on the server", null, 403));
  const { name, config } = req.body;
  const release = u.workspaceFile.lockWorkspaceFiles([resolve(u.plugins.toolsDirectory, `${name}.tool.js`)]);
  try {
    const { plugin } = await u.plugins.loadTool(name);
    const parsed = u.plugins.validateToolConfig(plugin, config);
    u.conf.set("toolConfigs", { ...u.conf.get("toolConfigs", {}), [name]: parsed });
    res.json(success(parsed, "Tool configuration saved"));
  } finally { release(); }
});
