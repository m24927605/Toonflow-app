import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.json(success({ url: await u.ai.startCodexLogin() }));
});
