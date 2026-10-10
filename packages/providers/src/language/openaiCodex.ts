export default {
  // Matches Pi's built-in provider ID so agents reuse its models and OAuth token refresh.
  id: "openai-codex" as const,
  label: "OpenAI Codex",
  version: "2.0.0",
  apiUrl: "https://chatgpt.com/backend-api",
  protocol: "openai-codex-responses",
  readme: "Sign in with a ChatGPT Plus or Pro subscription to use Codex models. Credentials stay in the local data directory and are only sent to OpenAI.",
  rules: [],
  models: [],
} satisfies ProviderDefinition<[]>;
