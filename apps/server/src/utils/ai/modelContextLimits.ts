// ACT: Strings match exactly first, regexes match in list order; both
// limits take precedence over user config and Pi's built-in model catalog.
// Units are tokens; checked against official standard API limits on 2026-09-20, excluding batch- or beta-only limits.
const modelContextLimits: { id: string | RegExp; contextWindow: number; maxTokens: number }[] = [
  // DeepSeek: the legacy deepseek-chat / deepseek-reasoner are retired; do not override same-named models on relay services.
  // https://api-docs.deepseek.com/quick_start/pricing/
  // https://api-docs.deepseek.com/api/create-chat-completion/
  // https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813/blob/main/config.json
  { id: "deepseek-flash", contextWindow: 1048576, maxTokens: 393216 },
  { id: "deepseek-v4-flash", contextWindow: 1048576, maxTokens: 393216 },
  { id: "deepseek-v4-pro", contextWindow: 1048576, maxTokens: 393216 },

  // OpenAI: per-model pages at https://developers.openai.com/api/docs/models/{model ID}
  { id: "gpt-5.5", contextWindow: 1050000, maxTokens: 128000 },
  { id: "gpt-5.4", contextWindow: 1050000, maxTokens: 128000 },
  { id: "gpt-5.4-pro", contextWindow: 1050000, maxTokens: 128000 },
  { id: "gpt-5.4-mini", contextWindow: 400000, maxTokens: 128000 },
  { id: "gpt-5.4-nano", contextWindow: 400000, maxTokens: 128000 },
  { id: "gpt-5.2", contextWindow: 400000, maxTokens: 128000 },
  { id: "gpt-5.1", contextWindow: 400000, maxTokens: 128000 },
  { id: "gpt-5", contextWindow: 400000, maxTokens: 128000 },
  { id: "gpt-5-mini", contextWindow: 400000, maxTokens: 128000 },
  { id: "gpt-4.1", contextWindow: 1047576, maxTokens: 32768 },
  { id: "gpt-4.1-mini", contextWindow: 1047576, maxTokens: 32768 },
  { id: "gpt-4.1-nano", contextWindow: 1047576, maxTokens: 32768 },
  { id: "gpt-4o", contextWindow: 128000, maxTokens: 16384 },

  // Claude: standard Messages API; the Batch API's 300K output limit is not used.
  // https://platform.claude.com/docs/en/models/overview
  // https://platform.claude.com/docs/en/build-with-claude/context-windows
  // https://platform.claude.com/docs/en/models/sonnet-4-6/overview
  // https://platform.claude.com/docs/es/models/sonnet-4-5/overview
  { id: "claude-fable-5-1", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-opus-5", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-4-6", contextWindow: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-4-5", contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-sonnet-4-5-20250929", contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-haiku-4-5", contextWindow: 200000, maxTokens: 64000 },
  { id: "claude-haiku-4-5-20251001", contextWindow: 200000, maxTokens: 64000 },

  // Qwen: the docs distinguish total context, max input and max output; use total context and max output.
  // https://help.aliyun.com/zh/model-studio/qwen3-5-plus
  // https://help.aliyun.com/zh/model-studio/qwen3-5-397b-a17b
  // https://help.aliyun.com/zh/model-studio/qwen3-5-35b-a3b
  // https://help.aliyun.com/zh/model-studio/qwen3-5-27b
  { id: "qwen3.5-plus", contextWindow: 1000000, maxTokens: 65536 },
  { id: "qwen3.5-plus-2026-04-20", contextWindow: 1000000, maxTokens: 65536 },
  { id: "qwen3.5-397b-a17b", contextWindow: 262144, maxTokens: 65536 },
  { id: "qwen3.5-35b-a3b", contextWindow: 262144, maxTokens: 65536 },
  { id: "qwen3.5-27b", contextWindow: 262144, maxTokens: 65536 },

  // GLM: https://docs.z.ai/guides/llm/glm-5, https://docs.z.ai/guides/llm/glm-4.7
  { id: "glm-5", contextWindow: 200000, maxTokens: 128000 },
  { id: "glm-4.7", contextWindow: 200000, maxTokens: 128000 },

  // Kimi: currently offered models; input and output share the window,
  // so the effective output limit must subtract prompt_tokens.
  // https://platform.kimi.ai/docs/models
  // https://platform.kimi.ai/docs/api/models-overview
  // https://www.kimi.ai/help/kimi-api/api-troubleshooting
  { id: "kimi-k3", contextWindow: 1048576, maxTokens: 1048576 },
  { id: "kimi-k2.7-code", contextWindow: 262144, maxTokens: 262144 },
  { id: "kimi-k2.7-code-highspeed", contextWindow: 262144, maxTokens: 262144 },
  { id: "kimi-k2.6", contextWindow: 262144, maxTokens: 262144 },

  // Volcengine Ark: context window and max response from the spec table, with k = 1024, not adding chain-of-thought.
  // https://docs.volcengine.com/docs/ark/model-list?lang=zh
  { id: "doubao-seed-evolving", contextWindow: 1048576, maxTokens: 262144 },
  { id: "doubao-seed-2-1-pro-260915", contextWindow: 1048576, maxTokens: 262144 },
  { id: "doubao-seed-2-1-pro-260628", contextWindow: 262144, maxTokens: 262144 },
  { id: "doubao-seed-2-1-turbo-260628", contextWindow: 262144, maxTokens: 262144 },
  { id: "doubao-seed-2-0-lite-260428", contextWindow: 262144, maxTokens: 131072 },
  { id: "doubao-seed-2-0-mini-260428", contextWindow: 262144, maxTokens: 131072 },
  { id: "doubao-seed-2-0-pro-260215", contextWindow: 262144, maxTokens: 131072 },
  { id: "doubao-seed-2-0-lite-260215", contextWindow: 262144, maxTokens: 131072 },
  { id: "doubao-seed-2-0-mini-260215", contextWindow: 262144, maxTokens: 131072 },
  { id: "doubao-seed-2-0-code-preview-260215", contextWindow: 262144, maxTokens: 131072 },
  { id: "doubao-seed-character-260628", contextWindow: 131072, maxTokens: 32768 },
  { id: "doubao-seed-1-8-251228", contextWindow: 262144, maxTokens: 32768 },
  { id: "doubao-seed-code-preview-251028", contextWindow: 262144, maxTokens: 32768 },
  { id: "doubao-seed-character-251128", contextWindow: 131072, maxTokens: 32768 },
  { id: "doubao-seed-1-6-flash-250828", contextWindow: 262144, maxTokens: 32768 },
  { id: "doubao-seed-translation-250915", contextWindow: 4096, maxTokens: 3072 },
  { id: "doubao-seed-1-6-vision-250815", contextWindow: 262144, maxTokens: 32768 },
  { id: "doubao-seed-1-6-250615", contextWindow: 262144, maxTokens: 32768 },
  { id: "doubao-seed-1-6-251015", contextWindow: 262144, maxTokens: 32768 },
  { id: "doubao-seed-1-6-flash-250615", contextWindow: 262144, maxTokens: 32768 },
  { id: "doubao-1-5-pro-32k-250115", contextWindow: 131072, maxTokens: 16384 },
  { id: "doubao-1-5-pro-32k-character-250715", contextWindow: 32768, maxTokens: 12288 },
  { id: "doubao-1-5-lite-32k-250115", contextWindow: 32768, maxTokens: 12288 },
  { id: "glm-5-3-flash-260828", contextWindow: 1048576, maxTokens: 131072 },
  { id: "glm-5-2-260617", contextWindow: 1048576, maxTokens: 131072 },
  { id: "glm-4-7-251222", contextWindow: 204800, maxTokens: 131072 },
  { id: "deepseek-v4-1-flash-260910", contextWindow: 1048576, maxTokens: 393216 },
  { id: "deepseek-v4-pro-ga-260813", contextWindow: 1048576, maxTokens: 393216 },
  { id: "deepseek-v4-flash-ga-260731", contextWindow: 1048576, maxTokens: 393216 },
  { id: "deepseek-v4-pro-260425", contextWindow: 1048576, maxTokens: 393216 },
  { id: "deepseek-v4-flash-260425", contextWindow: 1048576, maxTokens: 393216 },

  // Agnes: current GA API; 512K / 1M convert to 512 / 1024 units of 1024 tokens.
  // https://www.agnes-ai.com/zh-Hans/docs/agnes-30-flash
  // https://www.agnes-ai.com/zh-Hans/docs/agnes-25-flash
  // https://www.agnes-ai.com/zh-Hans/docs/agnes-25-pro
  { id: "agnes-3.0-flash", contextWindow: 524288, maxTokens: 65536 },
  { id: "agnes-2.5-flash", contextWindow: 524288, maxTokens: 65536 },
  { id: "agnes-2.5-pro", contextWindow: 1048576, maxTokens: 65536 },
];

export default modelContextLimits;
