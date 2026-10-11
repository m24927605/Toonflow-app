import { lstat, unlink, writeFile } from "@toonflow/file";
import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ name: u.extPlugins.extNameSchema, enabled: z.boolean() }), async (req, res) => {
  if (!u.workspace.isLocalWorkspaceRequest(req)) return res.status(403).json(error("Please manage file extensions locally on the server", null, 403));
  const { name, enabled } = req.body as { name: string; enabled: boolean };
  const path = resolve(u.extPlugins.extDirectory, `${name}.umd.js`);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    const file = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!file?.isFile()) return res.status(404).json(error("The file extension does not exist", null, 404));
    const markerPath = resolve(u.extPlugins.extDirectory, `${name}.disabled`);
    const marker = await lstat(markerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (marker && !marker.isFile()) return res.status(409).json(error("Invalid file extension state file", null, 409));
    if (enabled) await unlink(markerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    else if (!marker) await writeFile(markerPath, "", { flag: "wx" });
    res.json(success({ name, enabled }));
  } finally { release(); }
});
