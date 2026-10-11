import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const router = Router();

export default router.post("/", validateFields({
  apiUrl: z.url().refine(value => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "Please fill in the HTTP API base address without query parameters"),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "openai-codex-responses"]),
  apiKey: z.string().max(8192),
}), async (req, res) => {
  const { apiUrl, protocol, apiKey } = req.body as { apiUrl: string; protocol: string; apiKey: string };
  res.json(success(await u.ai.fetchProviderModels({ apiUrl, protocol, apiKey })));
});
