import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

export default Router().get("/", async (_req, res) => {
  const tools = await u.plugins.listTools();
  // ACT: Reuse the version read here; UI requests still check the current enabled state and source version.
  const renderers = tools.filter(tool => tool.enabled && !tool.loadError && tool.components.length)
    .map(tool => ({ name: tool.name, tools: tool.components, url: `/api/tools/client?name=${tool.name}&version=${tool.revision}` }));
  res.set("Cache-Control", "no-cache").json(success(renderers));
});
