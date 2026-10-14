export default {
  id: "colab" as const,
  label: "Colab CLI",
  version: "1.2.0",
  apiUrl: "",
  protocol: "colab-cli",
  readme: "Runs text generation through the Google Colab CLI installed and signed in on the computer running Toonflow. No API key or public tunnel is required. The first request starts an L4 session, installs pinned dependencies, downloads the selected model at a pinned revision and loads it in 4-bit precision (Venice, Huihui) or runs its GGUF quant with llama.cpp (the Qwen3.5/3.6 models; the 40B Thinking model uses IQ3_M to fit the L4 and returns its reasoning separately); later requests reuse the loaded model in the same session and run one at a time. Switching models reloads in the same session, with one model loaded at a time. The session stops after two idle minutes, when a request is cancelled or fails outside the model, when the server exits or restarts, or with Stop Colab session in the language model settings. Startup, model loading and idle minutes consume compute units. Replies appear when generation finishes. Supports text and text references in nodes; image/video inputs and Agents are rejected. Tool calls, such as the Director's Studio tool loop, work only with Qwen3.6-35B-A3B and run one model request per Colab job; the other models reject them. The total context is capped at 32K tokens and output at 8K tokens for this Colab deployment.",
  rules: [],
  models: [
    { id: "dphn/Dolphin-Mistral-24B-Venice-Edition", label: "Venice Uncensored 1.2", type: "text", contextWindow: 32768, maxOutputTokens: 8192 },
    { id: "huihui-ai/Huihui-Qwen3.8-27B-abliterated", label: "Huihui-Qwen3.8-27B-abliterated", type: "text", contextWindow: 32768, maxOutputTokens: 8192 },
    { id: "HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive", label: "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive", type: "text", contextWindow: 32768, maxOutputTokens: 8192 },
    { id: "HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive", label: "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive", type: "text", contextWindow: 32768, maxOutputTokens: 8192 },
    { id: "DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-NEO-CODE-Di-IMatrix-MAX-GGUF", label: "Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking", type: "text", contextWindow: 32768, maxOutputTokens: 8192 },
  ],
} satisfies ProviderDefinition<[]>;
