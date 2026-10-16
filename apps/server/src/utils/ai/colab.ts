import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { languageProviders } from "@toonflow/providers";
import { z } from "zod";
import { createColabWorker } from "@/utils/media/colab";
import type { readAiReferences } from "@/utils/ai";
import pipeline from "./colab.py" with { type: "text" };
import ggufPipeline from "./colabGguf.py" with { type: "text" };

const provider = languageProviders.find(item => item.protocol === "colab-cli")!;
// Pinned Hugging Face revisions, so a re-upload of a model never changes replies or loading behaviour unnoticed.
// Safetensors models are quantized to 4-bit with Transformers on load; GGUF models run on llama.cpp with the listed
// file, the largest quant measured to fit the L4 together with the 32K context.
// `tools` marks the models whose tool calls were checked to work through llama-server, such as the Director's Studio
// tool loop; every other model still rejects tools. `mmproj` is a GGUF model's vision projector, which lets it read
// images in user messages and image references; models without one read text only.
const weights: Record<string, { revision: string; gguf?: { file: string; thinking: boolean; mmproj?: string }; tools?: boolean }> = {
  "dphn/Dolphin-Mistral-24B-Venice-Edition": { revision: "b23ff40b4a25e4f93de432bd896d4464479a9f79" },
  "huihui-ai/Huihui-Qwen3.8-27B-abliterated": { revision: "739e3c5b89849f6c238ce1e5b70008612ae42cdd" },
  "HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive": {
    revision: "f12a584fecbeb5f20001130d8ecd66c9327ae685",
    gguf: { file: "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf", thinking: false, mmproj: "mmproj-Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-f16.gguf" },
    tools: true,
  },
  "HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive": {
    revision: "0a41c68809d375475f954be12ba7c40efa56c2a9",
    gguf: { file: "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q8_0.gguf", thinking: false },
  },
  // ACT: The 4-bit quants (22+ GB) leave no room for the 32K KV cache on the L4, so IQ3_M is used; a larger GPU would
  // allow IQ4_XS or Q4_K_M.
  "DavidAU/Qwen3.6-40B-Claude-4.6-Opus-Deckard-Heretic-Uncensored-Thinking-NEO-CODE-Di-IMatrix-MAX-GGUF": {
    revision: "a07c606ff200709e7094b1469aa8a1d9028720c9",
    gguf: { file: "Qwen3.6-40B-Deck-Opus-NEO-CODE-HERE-2T-OT-IQ3_M.gguf", thinking: true },
  },
};
// The loaded model stays on one L4 between requests and the session stops after two idle minutes.
const worker = createColabWorker(provider.id, { gpu: "L4" }, 120_000);
const resultSchema = z.object({
  text: z.string(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  reasoning: z.string().optional(), stopReason: z.enum(["stop", "length", "toolUse"]),
  toolCalls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.string() })).optional(), loadSeconds: z.number().nonnegative(), generateSeconds: z.number().nonnegative(),
});

/** Stops the text session now, cancelling the running request and every queued one. */
export const stopColab = () => worker.stop();

/** Keeps the text session open between requests until the returned release is called. */
export const holdColab = () => worker.hold();
/** Keeps the text model's L4 for at most `ms`, for requests known to follow. */
export const holdColabFor = (ms: number) => worker.holdFor(ms);

export function streamColab(providerId: string, modelId: string, context: Context, signal: AbortSignal, references: Awaited<ReturnType<typeof readAiReferences>>) {
  const model = provider.models.find(item => item.id === modelId);
  const weight = weights[modelId];
  if (providerId !== provider.id || !model || !weight) throw Object.assign(new Error("Unsupported Colab CLI model"), { status: 400 });
  if (!weight.tools && (context.tools?.length || context.messages.some(message => message.role === "toolResult" || (Array.isArray(message.content) && message.content.some(part => part.type === "toolCall"))))) {
    throw Object.assign(new Error("Colab CLI text generation does not support tool calls."), { status: 400 });
  }
  const vision = !!weight.gguf?.mmproj;
  const hasImages = (message: Context["messages"][number]) => Array.isArray(message.content) && message.content.some(part => part.type === "image");
  if (references.some(item => item.dataType !== "STRING" && !(vision && item.dataType === "IMAGE"))
    || context.messages.some(message => hasImages(message) && (!vision || message.role !== "user"))) {
    if (vision) throw Object.assign(new Error("This Colab CLI model reads text and images in user messages only."), { status: 400 });
    throw Object.assign(new Error("Colab CLI text generation only supports text inputs and text references."), { status: 400 });
  }
  const text = (content: string | { type: string; text?: string }[]) => typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text!] : []).join("\n");
  type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
  // A user message with images keeps its parts in order, images as data URLs; any other message is plain text.
  const userContent = (content: Context["messages"][number]["content"]): string | Part[] => typeof content === "string" || !content.some(part => part.type === "image") ? text(content as { type: string; text?: string }[] | string)
    : content.flatMap((part): Part[] => part.type === "text" ? [{ type: "text", text: part.text }] : part.type === "image" ? [{ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } }] : []);
  // llama-server takes the OpenAI chat format: tool calls ride on assistant messages and results come back as tool messages.
  const messages: { role: string; content: string | Part[]; tool_call_id?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }[] = context.messages.map(message => {
    if (message.role === "toolResult") return { role: "tool", tool_call_id: message.toolCallId, content: text(message.content) };
    if (message.role !== "assistant") return { role: message.role, content: userContent(message.content) };
    const calls = message.content.flatMap(part => part.type === "toolCall" ? [part] : []);
    return {
      role: "assistant", content: text(message.content),
      ...calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {},
    };
  });
  const firstUser = messages.find(message => message.role === "user");
  const plain = (content: string | Part[]) => typeof content === "string" ? content : content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
  if (!firstUser || !plain(firstUser.content).trim()) throw Object.assign(new Error("Colab CLI requires a non-empty text prompt."), { status: 400 });
  const tools = context.tools?.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  if (references.length) {
    const parts = references.flatMap((item, index): Part[] => item.dataType === "STRING" ? [{ type: "text", text: `\n{{ref ${index + 1}}}\n${item.value}` }]
      : [{ type: "text", text: `\n{{ref ${index + 1}}}` }, { type: "image_url", image_url: { url: item.value } }]);
    const merged = [...typeof firstUser.content === "string" ? [{ type: "text" as const, text: firstUser.content }] : firstUser.content, ...parts];
    firstUser.content = merged.every(part => part.type === "text") ? plain(merged) : merged;
  }
  // Given a long task, the model otherwise writes its plan and the tool arguments as text, which its chat template
  // allows before a call, so the reply ends without one; tool_choice "required" does not stop that text.
  const toolFormat = tools?.length ? "\n\nReply with exactly one tool call in the <tool_call> format and no other text until the task is done; only then reply with a short summary." : "";
  if (context.systemPrompt || toolFormat) messages.unshift({ role: "system", content: `${context.systemPrompt ?? ""}${toolFormat}`.trim() });
  signal.throwIfAborted();

  const output: AssistantMessage = {
    role: "assistant", content: [], api: "colab-cli", provider: providerId, model: modelId, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: output });
  // ACT: The CLI job downloads the complete reply; token streaming needs an incremental CLI transport.
  void (async () => {
    const ask = async (extra: typeof messages, toolChoice?: "required") => {
      const [data] = await worker.run((session, jobSignal) => session.job({
        script: weight.gguf ? ggufPipeline : pipeline,
        uploads: [{ name: "colabInput.json", data: JSON.stringify({
          modelId, revision: weight.revision, ...weight.gguf, messages: [...messages, ...extra], ...tools?.length ? { tools } : {}, ...toolChoice ? { toolChoice } : {},
          contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
        }) }],
        env: {}, outputs: ["/content/colabOutput.json"],
      }, jobSignal), signal);
      const reply = resultSchema.parse(JSON.parse(new TextDecoder().decode(data)));
      console.log(`[colab] ${modelId}: load ${reply.loadSeconds} s, ${reply.outputTokens} tokens in ${reply.generateSeconds} s`);
      return reply;
    };
    // ACT: Given a long task the model now and then writes the tool arguments out as a JSON document instead of calling
    // a tool, which ends the tool loop with nothing done. Such a reply goes back once with a correction and the call
    // required; one that is still text ends the loop as before. A leading "{" or code fence marks the document.
    const writtenOut = (reply: z.infer<typeof resultSchema>) => !!tools?.length && !reply.toolCalls?.length && /^\s*(\{|```)/.test(reply.text);
    let result = await ask([]);
    if (writtenOut(result)) {
      console.warn(`[colab] ${modelId} wrote its tool call as text; asking again`);
      result = await ask([
        { role: "assistant", content: result.text },
        { role: "user", content: "That reply was text, so nothing was done. Do the work with the tools: reply with one tool call now." },
      ], "required");
      if (writtenOut(result)) console.warn(`[colab] ${modelId} wrote its tool call as text again: ${result.text.slice(0, 1500)}`);
    }
    const toolCalls = (result.toolCalls ?? []).map(call => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(call.arguments || "{}");
      } catch {
        throw new Error(`${modelId} returned invalid JSON arguments for ${call.name}`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${modelId} returned non-object arguments for ${call.name}`);
      return { type: "toolCall" as const, id: call.id, name: call.name, arguments: parsed as Record<string, never> };
    });
    output.content = [
      ...result.reasoning ? [{ type: "thinking" as const, thinking: result.reasoning }] : [],
      ...result.text || !toolCalls.length ? [{ type: "text" as const, text: result.text }] : [],
      ...toolCalls,
    ];
    output.stopReason = result.stopReason;
    output.usage.input = result.inputTokens;
    output.usage.output = result.outputTokens;
    output.usage.totalTokens = result.inputTokens + result.outputTokens;
    if (result.reasoning) stream.push({ type: "thinking_delta", contentIndex: 0, delta: result.reasoning, partial: output });
    if (result.text) stream.push({ type: "text_delta", contentIndex: result.reasoning ? 1 : 0, delta: result.text, partial: output });
    stream.push({ type: "done", reason: result.stopReason, message: output });
  })().catch((error: unknown) => {
    const reason = signal.aborted ? "aborted" : "error";
    stream.push({ type: "error", reason, error: { ...output, stopReason: reason, errorMessage: error instanceof Error ? error.message : "Colab CLI generation failed" } });
  });
  return stream;
}
