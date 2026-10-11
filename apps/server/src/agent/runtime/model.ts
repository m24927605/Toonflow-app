import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getConfiguredModel } from "@/utils/ai";
import { createCodexRuntime } from "@/utils/ai/codex";

export async function createAgentModel(providerId: string, modelId: string, thinkingLevel = "off") {
  const configured = getConfiguredModel(providerId, modelId);
  const { provider, model, baseUrl } = configured;
  if (provider.protocol === "claude-code") throw Object.assign(new Error("Claude Code is only used for node generation. Choose another model for the Agent."), { status: 400 });
  // ACT: Codex uses Pi's built-in provider so the OAuth credential in auth.json is refreshed per request and long
  // conversations do not outlive the access token.
  if (provider.protocol === "openai-codex-responses") return { ...configured, runtime: await createCodexRuntime() };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(providerId, {
    api: provider.protocol,
    baseUrl,
    models: [{
      id: model.id, name: model.label, reasoning: thinkingLevel !== "off",
      // ACT: Keep image input and let the actual provider decide whether the model supports it.
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens,
    }],
  });
  await runtime.setRuntimeApiKey(providerId, provider.apiKey);
  return { ...configured, runtime };
}
