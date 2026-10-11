import { lstat, unlink, writeFile } from "@toonflow/file";
import { resolve } from "node:path";
import { Router } from "express";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().delete("/", validateFields({ name: u.extPlugins.extNameSchema }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please uninstall file extensions locally on the server", null, 403));
  const name = req.body.name as string;
  const path = resolve(u.extPlugins.extDirectory, `${name}.umd.js`);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    const file = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!file?.isFile()) return res.status(404).json(error("The file extension does not exist", null, 404));
    const markerPath = resolve(u.extPlugins.extDirectory, `${name}.disabled`);
    const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (marker && !marker.isFile()) return res.status(409).json(error("Invalid file extension state file", null, 409));
    const removedPath = resolve(u.extPlugins.extDirectory, `${name}.removed`);
    let recorded = false;
    await writeFile(removedPath, "", { flag: "wx" }).then(() => { recorded = true; }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    try { await unlink(path); }
    catch (error) {
      if (recorded) await unlink(removedPath);
      throw error;
    }
    await unlink(markerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    const configs = u.conf.get("extConfigs", {});
    delete configs[name];
    u.conf.set("extConfigs", configs);
    res.json(success(null, "File extension uninstalled"));
  } finally { release(); }
});
