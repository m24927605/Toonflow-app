import { stat } from "@toonflow/file";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096) }), async (req, res) => {
  const native = process.env.NODE_ENV === "dev" && ["win32", "darwin"].includes(process.platform);
  if (!native || !u.workspace.isLocalWorkspaceRequest(req)) throw Object.assign(new Error("Showing a file in its folder only works on the local development page"), { status: 403 });
  const { path } = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  await stat(path);
  const child = process.platform === "win32"
    ? spawn(resolve(process.env.WINDIR ?? "C:\\Windows", "explorer.exe"), ["/select,", path], { windowsHide: true, stdio: "ignore" })
    : spawn("/usr/bin/open", ["-R", path], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("spawn", resolve); });
  child.unref();
  res.json(success());
});
