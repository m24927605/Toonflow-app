import { lstat, unlink } from "@toonflow/file";
import { resolve } from "node:path";
import { Router } from "express";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

export default router.delete("/", validateFields({ name: u.plugins.toolNameSchema }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please manage tools locally on the server", null, 403));
  const { name } = req.body as { name: string };
  const path = resolve(u.plugins.toolsDirectory, `${name}.tool.js`);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    if (!(await lstat(path)).isFile()) return res.status(400).json(error("The tool file is invalid", null, 400));
    await unlink(path);
    await unlink(resolve(u.plugins.toolsDirectory, `${name}.disabled`)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    const configs = u.conf.get("toolConfigs", {});
    delete configs[name];
    u.conf.set("toolConfigs", configs);
    res.json(success(null, "Tool has been uninstalled"));
  } finally { release(); }
});
