import { t } from "@/lib/i18n";
import { z } from "zod";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { codexProviderId } from "@/utils/ai/codex";

const modelSchema = z.object({
  id: z.string().optional(), name: z.string().optional(),
  display_name: z.string().optional(), displayName: z.string().optional(),
  inputTokenLimit: z.number().int().positive().optional(),
  outputTokenLimit: z.number().int().positive().optional(),
});

export async function fetchProviderModels({ apiUrl, protocol, apiKey }: { apiUrl: string; protocol: string; apiKey: string }) {
  // The Codex subscription has no public model list endpoint; use Pi's built-in catalog, which ships with each release.
  if (protocol === "openai-codex-responses") {
    return getBuiltinModels(codexProviderId).map(model => ({ id: model.id, label: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens }));
  }
  const url = new URL(apiUrl);
  if (url.pathname === "/") url.pathname = "/v1";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (protocol === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    headers["x-api-key"] = apiKey;
    url.searchParams.set("limit", "1000");
  } else if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const models = new Map<string, { id: string; label: string; contextWindow?: number; maxOutputTokens?: number }>();
  const cursors = new Set<string>();
  const signal = AbortSignal.timeout(30000);
  while (true) {
    const response = await fetch(url, { headers, signal, redirect: "error" });
    if (!response.ok) throw new Error(t`Failed to get model list (HTTP ${response.status}), please check API address, protocol and key`);
    const result = z.object({
      data: z.array(modelSchema),
      has_more: z.boolean().optional(), last_id: z.string().nullable().optional(),
    }).parse(await response.json());
    const items = result.data;
    for (const item of items) {
      const id = item.id?.trim();
      if (!id) throw new Error("Model list contains an invalid model ID");
      models.set(id, { id, label: item.display_name || item.displayName || id, contextWindow: item.inputTokenLimit, maxOutputTokens: item.outputTokenLimit });
    }
    const cursor = protocol === "anthropic-messages" && result.has_more ? result.last_id : undefined;
    if (protocol === "anthropic-messages" && result.has_more && !cursor) throw new Error("Model list is missing paging cursor");
    if (!cursor) break;
    if (cursors.has(cursor)) throw new Error("Duplicate paging cursor in model list");
    cursors.add(cursor);
    url.searchParams.set("after_id", cursor);
  }
  return [...models.values()];
}
