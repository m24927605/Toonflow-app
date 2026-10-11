import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", validateFields({ name: u.nodePlugins.nodeNameSchema, config: z.record(z.string(), z.json()) }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please manage node configuration locally on the server", null, 403));
  const { name, config } = req.body;
  const release = u.workspaceFile.lockWorkspaceFiles([resolve(u.nodePlugins.nodesDirectory, `${name}.umd.js`)]);
  try {
    const { configRules } = await u.nodePlugins.readNode(name);
    const parsed = u.nodePlugins.validateNodeConfig(configRules, config);
    u.conf.set("nodeConfigs", { ...u.conf.get("nodeConfigs", {}), [name]: parsed });
    res.json(success(parsed, "Node configuration saved"));
  } finally { release(); }
});
