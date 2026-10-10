import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ code: z.string().trim().min(1).max(4096) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  await u.ai.submitCodexCode(req.body.code.trim());
  res.json(success(null, "登录成功"));
});
