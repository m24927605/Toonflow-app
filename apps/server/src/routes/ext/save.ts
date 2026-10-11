import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ name: u.extPlugins.extNameSchema, config: z.record(z.string(), z.json()) }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please manage file extension settings locally on the server", null, 403));
  const { name, config } = req.body;
  const release = u.workspaceFile.lockWorkspaceFiles([resolve(u.extPlugins.extDirectory, `${name}.umd.js`)]);
  try {
    const { configRules } = await u.extPlugins.readExt(name);
    const parsed = u.extPlugins.validateExtConfig(configRules, config);
    u.conf.set("extConfigs", { ...u.conf.get("extConfigs", {}), [name]: parsed });
    res.json(success(parsed, "File extension settings saved"));
  } finally { release(); }
});
