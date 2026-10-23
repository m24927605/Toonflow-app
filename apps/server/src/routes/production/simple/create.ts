import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({
  id: z.string().uuid(),
  outline: z.string().trim().min(1).max(20000),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const cwd = await u.workspace.resolveWorkspace(req, await u.production.simpleWorkspaceDirectory());
  try { await u.production.createSimpleProduction(cwd, req.body.id, req.body.outline.trim(), false); }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    res.status(409).json(error("This production already exists", undefined, 409));
    return;
  }
  res.json(success({ id: req.body.id }));
});
