import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  res.json(success(u.ai.getCodexStatus()));
});
