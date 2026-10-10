import { Router } from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  await u.ai.logoutCodex();
  res.json(success(null, "已退出登录"));
});
