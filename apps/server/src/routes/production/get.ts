import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, String(req.query.directory));
  const id = String(req.query.id);
  const production = await u.production.readProduction(cwd, id).catch(() => undefined);
  if (!production) {
    res.status(404).json(error("This node has no production"));
    return;
  }
  // A production left running by a stopped runner, such as after a server restart, continues when its page looks.
  if (production.status === "running" && !u.production.isProductionRunning(cwd, id)) u.production.runProduction(cwd, id);
  const read = (text?: { path: string }) => text ? u.production.readProductionText(cwd, text) : undefined;
  const [script, shotList] = await Promise.all([read(production.script), read(production.shotList)]);
  res.json(success({ production, script, shotList, estimate: u.production.estimateProduction(production.input) }));
});
