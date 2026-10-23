import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { directory, id } = req.body as { directory: string; id: string };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  if ((await u.production.readProduction(cwd, id)).input.mode === "simple") throw Object.assign(new Error("Simple productions do not accept manual intervention"), { status: 409 });
  await u.production.stopProduction(cwd, id);
  res.json(success());
});
