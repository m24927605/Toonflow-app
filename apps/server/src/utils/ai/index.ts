import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import conf from "@/utils/conf";
import { readReference } from "@/utils/media/generation";
import modelContextLimits from "@/utils/ai/modelContextLimits";
import { codexProviderId, createCodexRuntime, getCodexStatus } from "@/utils/ai/codex";
import { streamClaudeCode } from "@/utils/ai/claudeCode";
import { streamColab } from "@/utils/ai/colab";

export { claudeCodeToolsRouter } from "@/utils/ai/claudeCode";
export { holdColab, stopColab } from "@/utils/ai/colab";

export { fetchProviderModels } from "@/utils/ai/models";
export { startCodexLogin, submitCodexCode, getCodexStatus, logoutCodex } from "@/utils/ai/codex";

export const providerSchema = z.object({
  // Claude Code runs the local CLI and has no API URL.
  apiUrl: z.union([z.url({ protocol: /^https?$/ }), z.literal("")]),
  apiKey: z.string(),
  protocol: z.enum(["openai-completions", "openai-responses", "anthropic-messages", "openai-codex-responses", "claude-code", "colab-cli"]),
  models: z.array(z.object({
    id: z.string(), label: z.string(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })),
});

const builtinModels = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider));

export function getModelLimits(providerId: string, model: z.infer<typeof providerSchema>["models"][number]) {
  // ACT: The Codex subscription backend has different limits from the public API, so use Pi's openai-codex catalog.
  const codexModel = providerId === codexProviderId ? builtinModels.find(item => item.provider === providerId && item.id === model.id) : undefined;
  if (codexModel) return { contextWindow: codexModel.contextWindow, maxTokens: codexModel.maxTokens };
  const limits = modelContextLimits.find(item => item.id === model.id)
    ?? modelContextLimits.find(item => item.id instanceof RegExp && model.id.search(item.id) !== -1);
  if (limits) return { contextWindow: limits.contextWindow, maxTokens: limits.maxTokens };
  if (model.contextWindow != null && model.maxOutputTokens != null) {
    return { contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens };
  }
  const matches = builtinModels.filter(item => item.id === model.id);
  const exact = matches.find(item => item.provider === providerId);
  const candidates = exact ? [exact] : matches;
  // ACT: Match IDs exactly; same-named params across providers are used only if every field matches; no alias guessing.
  const contextWindow = candidates.every(item => item.contextWindow === candidates[0]?.contextWindow) ? candidates[0]?.contextWindow : undefined;
  const maxTokens = candidates.every(item => item.maxTokens === candidates[0]?.maxTokens) ? candidates[0]?.maxTokens : undefined;
  return {
    contextWindow: model.contextWindow ?? contextWindow ?? 262144,
    maxTokens: model.maxOutputTokens ?? maxTokens ?? 32768,
  };
}

/**
 * The API key sent with a request. The settings allow an empty key for local services such as Ollama, but the model
 * clients treat an empty key as missing, so a placeholder stands in; services that do check keys reject it with their
 * own authentication error.
 */
export function requestApiKey(apiKey: string) {
  return apiKey.trim() || "no-key";
}

export function getConfiguredModel(providerId: string, modelId: string) {
  const providers = conf.get("settings", {}).customProviders;
  const parsed = providerSchema.safeParse(Array.isArray(providers) ? providers.find(item => item?.id === providerId) : undefined);
  if (!parsed.success) throw Object.assign(new Error("Please configure the model provider in settings first"), { status: 400 });
  const provider = parsed.data;
  const model = provider.models.find(item => item.id === modelId);
  if (!model) throw Object.assign(new Error("The selected model does not exist, please select again."), { status: 400 });
  const baseUrl = provider.apiUrl ? new URL(provider.apiUrl) : undefined;
  if (baseUrl?.pathname === "/") baseUrl.pathname = "/v1";
  const limits = getModelLimits(providerId, model);
  return { providerId, provider, model: { ...model, contextWindow: limits.contextWindow, maxOutputTokens: limits.maxTokens }, baseUrl: baseUrl?.href.replace(/\/+$/, "") ?? "" };
}

export function listAiModels() {
  const providers = conf.get("settings", {}).customProviders;
  if (!Array.isArray(providers)) return [];
  return providers.flatMap(item => {
    const parsed = providerSchema.extend({ id: z.string().min(1), label: z.string() }).safeParse(item);
    if (!parsed.success) return [];
    const provider = parsed.data;
    return provider.models.filter(model => model.id.trim()).map(model => {
      const limits = getModelLimits(provider.id, model);
      return {
        providerId: provider.id, providerLabel: provider.label, protocol: provider.protocol, modelId: model.id, label: model.label,
        contextWindow: limits.contextWindow, maxOutputTokens: limits.maxTokens,
      };
    });
  });
}

const aiApis = {
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
  "anthropic-messages": anthropicMessagesApi(),
};

export const aiReferenceSchema = z.discriminatedUnion("dataType", [
  z.object({ dataType: z.literal("STRING"), value: z.string().max(1000000) }),
  z.object({ dataType: z.literal("IMAGE"), value: z.object({ url: z.string().min(1).max(4096), mimeType: z.string().startsWith("image/") }) }),
  z.object({ dataType: z.literal("VIDEO"), value: z.object({ url: z.string().min(1).max(4096), mimeType: z.string().startsWith("video/") }) }),
]);

export async function readAiReferences(directory: string | undefined, references: z.infer<typeof aiReferenceSchema>[], signal?: AbortSignal) {
  return Promise.all(references.map(async (item) => {
    if (item.dataType === "STRING") return { dataType: item.dataType, value: item.value };
    if (!directory) throw Object.assign(new Error("Media reference requires working directory"), { status: 400 });
    const media = await readReference(directory, { path: item.value.url, mimeType: item.value.mimeType }, item.dataType.toLowerCase(), signal);
    return { dataType: item.dataType, value: `data:${media.mimeType};base64,${media.data}` };
  }));
}

/** The Codex backend uses the Responses request body, so attachments follow the openai-responses format. */
export function isResponsesProtocol(protocol: string) {
  return protocol === "openai-responses" || protocol === "openai-codex-responses";
}

export function referenceContent(protocol: string, prompt: string, references: Awaited<ReturnType<typeof readAiReferences>>) {
  const textPart = (text: string) => ({ type: isResponsesProtocol(protocol) ? "input_text" : "text", text });
  const content: object[] = [textPart(prompt)];
  references.forEach((item, index) => {
    content.push(textPart(`{{ref ${index + 1}}}${item.dataType === "STRING" ? `\n${item.value}` : ""}`));
    if (item.dataType === "STRING") return;
    if (protocol === "openai-completions") {
      content.push(item.dataType === "IMAGE"
        ? { type: "image_url", image_url: { url: item.value } }
        : { type: "video_url", video_url: { url: item.value } });
    } else if (isResponsesProtocol(protocol)) {
      const extension = item.value.slice(11, item.value.indexOf(";")).replace("quicktime", "mov");
      content.push(item.dataType === "IMAGE"
        ? { type: "input_image", image_url: item.value, detail: "auto" }
        : { type: "input_file", filename: `reference${index + 1}.${extension}`, file_data: item.value });
    } else {
      const separator = item.value.indexOf(",");
      content.push({
        type: item.dataType === "IMAGE" ? "image" : "document",
        source: { type: "base64", media_type: item.value.slice(5, item.value.indexOf(";")), data: item.value.slice(separator + 1) },
      });
    }
  });
  return content;
}

export async function streamAi(
  configured: ReturnType<typeof getConfiguredModel>,
  context: Context,
  signal: AbortSignal,
  references: Awaited<ReturnType<typeof readAiReferences>> = [],
  session?: string,
) {
  const { provider, model: configuredModel, baseUrl } = configured;
  if (provider.protocol === "colab-cli") {
    return streamColab(configured.providerId, configuredModel.id, context, signal, references);
  }
  if (provider.protocol === "claude-code") {
    return await streamClaudeCode(configured.providerId, configuredModel.id, context, signal, referenceContent("anthropic-messages", "", references).slice(1), session);
  }
  // ACT: Do not infer attachment support from the model name; pass
  // attachments per the provider protocol and let the upstream API decide.
  const onPayload = references.length ? (payload: unknown) => {
    const body = payload as Record<string, unknown>;
    const field = isResponsesProtocol(provider.protocol) ? "input" : "messages";
    const messages = body[field] as { role: string; content: unknown }[];
    // ACT: Later Anthropic tool results also use the user role, so attachments are only added to the initial input.
    const firstUser = messages.findIndex(message => message.role === "user");
    const attachmentContent = referenceContent(provider.protocol, "", references).slice(1);
    return { ...body, [field]: messages.map((message, index) => index === firstUser
      ? { ...message, content: [
        ...(Array.isArray(message.content) ? message.content : referenceContent(provider.protocol, String(message.content ?? ""), [])),
        ...attachmentContent,
      ] }
      : message) };
  } : undefined;
  if (provider.protocol === "openai-codex-responses") {
    if (!getCodexStatus().loggedIn) throw Object.assign(new Error("Sign in to OpenAI Codex in Settings first"), { status: 400 });
    const runtime = await createCodexRuntime();
    const model = runtime.getModel(codexProviderId, configuredModel.id);
    if (!model) throw Object.assign(new Error("The selected model does not exist, please select again."), { status: 400 });
    return runtime.streamSimple(model, context, { signal, onPayload });
  }
  const model: Model<typeof provider.protocol> = {
    id: configuredModel.id, name: configuredModel.label, provider: "toonflow", api: provider.protocol, baseUrl,
    reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: configuredModel.contextWindow,
    maxTokens: configuredModel.maxOutputTokens,
  };
  return aiApis[provider.protocol].streamSimple(model, normalizeContext(context), { apiKey: requestApiKey(provider.apiKey), signal, onPayload });
}
