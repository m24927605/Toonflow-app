import { onScopeDispose } from "vue";
import { translate } from "@toonflow/i18n/vue";
import { runAgentLoop, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, createInitialSystemMessage, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type Context, type Message, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { EventSourceParserStream } from "eventsource-parser/stream";
import type { MediaGenerationRequest, MediaModel } from "@toonflow/tools-scaffold/runtime";
import type { NodeOutput } from "./values";

export type NodeAiModel = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages" | "openai-codex-responses" | "claude-code" | "colab-cli";
  contextWindow?: number;
  maxOutputTokens?: number;
};
export type NodeMediaModel = Omit<MediaModel, "mode"> & {
  mode?: (string | string[])[];
};
export type NodeImageRequest = {
  directory: string;
  providerId: string;
  modelId: string;
  prompt: string;
  outputDirectory: string;
  images?: { path: string; mimeType: string }[];
  ratio?: string;
  size?: string;
  characterId?: string;
  skipTextCheck?: boolean;
};
export type NodeImageResult = { path: string; mimeType: string; mediaType: "image" };
export type NodeVideoRequest = Omit<MediaGenerationRequest, "size"> & { directory: string; outputDirectory: string };
export type NodeVideoResult = { path: string; mimeType: string; mediaType: "video" };
export type NodeAudioRequest = Pick<MediaGenerationRequest, "providerId" | "modelId" | "prompt" | "images" | "audios" | "voice" | "emotion" | "speed" | "volume" | "pitch" | "language" | "format" | "sampleRate" | "duration"> & { directory: string; outputDirectory: string };
export type NodeAudioResult = { path: string; mimeType: string; mediaType: "audio" };
export type NodeLoraKind = "character" | "scene" | "costume" | "style" | "motion" | "voice" | "slider";
export type NodeLoraFamily = "h3" | "qwen";
/**
 * What to train: images, clips or recordings (a caption such as a voice line's transcript replaces the automatic one),
 * or a slider's prompts; one LoRA per model family, trained side by side.
 */
export type NodeLoraTraining = {
  directory: string; kind: NodeLoraKind; families: NodeLoraFamily[]; name: string;
  items: { path: string; caption?: string }[];
  slider?: { base: string; positive: string; negative: string };
};
/** A trained LoRA as recorded beside it in the workspace's `loras/` folder. */
export type NodeLoraRecord = { name: string; kind: NodeLoraKind; family: NodeLoraFamily; trigger: string; path: string; createdAt: string };
export type NodeAiRequest = {
  providerId: string;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  directory?: string;
  references?: Extract<NodeOutput, { dataType: "STRING" | "IMAGE" | "VIDEO" }>[];
  tools?: NodeAiTool[];
  onEvent?: (event: NodeAiEvent) => void;
  signal?: AbortSignal;
};
export type NodeAiResult = {
  text: string;
  reasoning?: string;
};
export type NodeAiEvent = { type: "text" | "reasoning"; delta: string }
  | { type: "toolStart"; id: string; name: string; args: unknown }
  | { type: "toolEnd"; id: string; name: string; result: unknown; isError: boolean };
export type NodeAiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): unknown | Promise<unknown>;
};

async function readResult<T>(response: Response): Promise<T> {
  // An empty or non-JSON body means the server went away mid-request, typically a restart that also dropped the job.
  const result = await response.json().catch(() => {
    throw new Error(translate("The server did not respond, it may have restarted. This generation was stopped; please generate again."));
  });
  if (!response.ok || result.code !== 200) throw new Error(result.message || `AI 请求失败（HTTP ${response.status}）`);
  return result.data;
}

// ACT: Each standalone UMD has its own module scope, so they share a host cache;
// it is invalidated when model settings are saved, avoiding repeated per-node requests.
const modelCacheKey = Symbol.for("toonflow.nodeModels");
const modelCacheHost = globalThis as typeof globalThis & { [modelCacheKey]?: Map<string, Promise<unknown[]>> };
const modelCache = modelCacheHost[modelCacheKey] ??= new Map<string, Promise<unknown[]>>();

export function invalidateNodeModels(type: "language" | "media") {
  modelCache.delete(type === "language" ? "/api/ai/models" : "/api/ai/media/models");
}

async function readModels<T>(url: string, signal: AbortSignal): Promise<T[]> {
  signal.throwIfAborted();
  let pending = modelCache.get(url);
  if (!pending) {
    const request = fetch(url, { cache: "no-store" }).then(readResult<unknown[]>).catch(error => {
      if (modelCache.get(url) === request) modelCache.delete(url);
      throw error;
    });
    pending = request;
    modelCache.set(url, request);
  }
  // Closing one node only cancels its own wait and must not abort requests shared with other nodes.
  let cancel = () => {};
  try {
    const models = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
    signal.throwIfAborted();
    return modelCache.get(url) === pending ? models as T[] : readModels<T>(url, signal);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function requestModel(input: NodeAiRequest, transcript: TranscriptContext, model: Model<NodeAiModel["protocol"]>, signal: AbortSignal, session?: string) {
  const { providerId, modelId, references, directory, onEvent } = input;
  // The server API keeps the flat context shape; system messages carry the prompt and tool declarations in the transcript.
  const tools = getCurrentTools(transcript.messages);
  const context: Context = {
    systemPrompt: getCurrentSystemPrompt(transcript.messages) || undefined,
    messages: transcript.messages.filter(message => message.role !== "system"),
    ...(tools.length ? { tools } : {}),
  };
  const stream = createAssistantMessageEventStream();
  try {
    signal.throwIfAborted();
    const response = await fetch("/api/ai/generate", {
      method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ providerId, modelId, context, directory, references, session }), signal,
    });
    if (!response.ok) await readResult(response);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("AI 未返回 SSE 数据流");
    const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) throw new Error("AI 数据流提前结束，请重试");
        const event = JSON.parse(value.data);
        if (event.type === "error") throw new Error(event.message || "AI 生成失败");
        if (event.type === "text" || event.type === "reasoning") onEvent?.(event);
        if (event.type !== "done") continue;
        const message = event.message as AssistantMessage;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) throw new Error("AI 返回消息不完整，请确认服务端已更新");
        if (message.stopReason === "deferred" || message.stopReason === "pending") throw new Error("AI 返回了未完成的任务");
        if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "AI 请求失败");
        // ACT: Deltas notify the UI directly; the SDK only consumes complete per-turn messages,
        // avoiding a full snapshot per token.
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: message.stopReason, message });
        break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    const reason = signal.aborted ? "aborted" : "error";
    const failure = error instanceof DOMException && error.name === "TimeoutError" ? new Error("模型单轮响应超过 10 分钟，已停止") : error;
    stream.push({ type: "error", reason, error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: reason, errorMessage: failure instanceof Error ? failure.message : "AI 请求失败",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
  }
  return stream;
}

export function useNodeAi() {
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());
  const requestSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  async function getModels(signal?: AbortSignal) {
    return readModels<NodeAiModel>("/api/ai/models", requestSignal(signal));
  }

  async function getMediaModels(signal?: AbortSignal) {
    return readModels<NodeMediaModel>("/api/ai/media/models", requestSignal(signal));
  }

  /** Runs host work that can take minutes; the host asks before leaving the page while it runs. */
  async function guarded<T>(work: () => Promise<T>) {
    // The server cancels background jobs no page polls, so leaving the page would stop the work.
    const host = (window as { toonflowNodeHost?: { generations?: { begin(): () => void } } }).toonflowNodeHost;
    const end = host?.generations?.begin();
    try {
      return await work();
    } finally {
      end?.();
    }
  }

  async function generateMedia<T extends "image" | "video" | "audio">(mediaType: T, input: NodeImageRequest | NodeVideoRequest | NodeAudioRequest, signal?: AbortSignal) {
    return guarded(() => runJob<{ path: string; mimeType: string; mediaType: T }[]>("/api/ai/media/generate", { ...input, mediaType }, input.directory, signal));
  }

  /**
   * Trains a LoRA per model family on Colab (about half an hour) and returns their records: the workspace path, the
   * trigger word that names what it learned in prompts, and its kind and model family. Training keeps running on the
   * server when the page closes, and its LoRAs then appear in the workspace's `loras/` folder.
   */
  async function trainLora(input: NodeLoraTraining, signal?: AbortSignal) {
    return guarded(() => runJob<NodeLoraRecord[]>("/api/ai/lora/train", input, input.directory, signal, true));
  }

  /** `keepOnLeave` jobs are cancelled only through `signal`; leaving the page or the canvas just stops waiting. */
  async function runJob<T>(url: string, body: object, directory: string, signal?: AbortSignal, keepOnLeave = false) {
    const jobSignal = requestSignal(signal);
    const headers = { "Content-Type": "application/json", "x-toonflow-workspace": "1" };
    const { id } = await readResult<{ id: string }>(await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: jobSignal }));
    // The server runs the job in the background, so polling keeps browser connections free for other requests;
    // Chrome allows only six per host and a long generation used to hold one for its whole run.
    const query = new URLSearchParams({ id, directory });
    try {
      while (true) {
        jobSignal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(jobSignal.reason);
          };
          const timer = setTimeout(() => {
            jobSignal.removeEventListener("abort", abort);
            resolve();
          }, 2000);
          jobSignal.addEventListener("abort", abort, { once: true });
        });
        const state = await readResult<{ done: boolean; result?: T }>(
          await fetch(`/api/ai/media/jobs/get?${query}`, { headers, cache: "no-store", signal: jobSignal }),
        );
        if (state.done) return state.result as T;
      }
    } catch (error) {
      if (keepOnLeave ? signal?.aborted : jobSignal.aborted) void fetch("/api/ai/media/jobs/cancel", { method: "POST", headers, body: JSON.stringify({ id, directory }) }).catch(() => {});
      throw error;
    }
  }

  function generateImage(input: NodeImageRequest, signal?: AbortSignal) {
    return generateMedia("image", input, signal);
  }

  function generateVideo(input: NodeVideoRequest, signal?: AbortSignal) {
    return generateMedia("video", input, signal);
  }

  function generateAudio(input: NodeAudioRequest, signal?: AbortSignal) {
    return generateMedia("audio", input, signal);
  }

  async function generate(input: NodeAiRequest): Promise<NodeAiResult> {
    const signal = requestSignal(input.signal);
    // Tool loops limit each model turn to 10 minutes rather than the whole loop: reasoning models can think for minutes
    // per turn, so a whole-loop limit cut off healthy runs, while the 40-turn cap below already bounds the loop.
    const turnSignal = () => input.tools?.length ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : signal;
    // Every turn of one tool loop shares a session ID, so the server can keep the same model session across turns.
    const session = input.tools?.length ? crypto.randomUUID() : undefined;
    const { providerId, modelId, prompt, systemPrompt, onEvent } = input;
    if (!prompt.trim()) throw new Error("请输入提示词");
    const definitions = input.tools ?? [];
    if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) throw new Error("工具名称不能重复");
    const selected = (await getModels(signal)).find(model => model.providerId === providerId && model.modelId === modelId);
    if (!selected) throw new Error("所选模型不存在，请重新选择");
    const model: Model<NodeAiModel["protocol"]> = {
      id: modelId, name: selected.label, provider: providerId, api: selected.protocol, baseUrl: "",
      reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: selected.contextWindow ?? 262144, maxTokens: selected.maxOutputTokens ?? 32768,
    };
    const tools: AgentTool[] = definitions.map(tool => ({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      async execute(_id, args, toolSignal) {
        signal.throwIfAborted();
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
        const result = await tool.execute(args as Record<string, unknown>, toolSignal) ?? null;
        signal.throwIfAborted();
        return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }], details: undefined };
      },
    }));
    let turns = 0;
    const system = createInitialSystemMessage(systemPrompt, undefined);
    const messages = await runAgentLoop([{ role: "user", content: prompt, timestamp: Date.now() }], {
      messages: system ? [system] : [], tools,
    }, {
      model, convertToLlm: messages => messages as Message[], toolExecution: "sequential",
      finishTurn: ({ message }) => ++turns >= 40 || message.stopReason === "length" ? { action: "end" } : undefined,
    }, event => {
      signal.throwIfAborted();
      if (event.type === "tool_execution_start") onEvent?.({ type: "toolStart", id: event.toolCallId, name: event.toolName, args: event.args });
      if (event.type === "tool_execution_end" && onEvent) {
        const text = (event.result as AgentToolResult<unknown>).content.filter(part => part.type === "text").map(part => part.text).join("\n");
        onEvent({ type: "toolEnd", id: event.toolCallId, name: event.toolName, result: event.isError ? text : JSON.parse(text), isError: event.isError });
      }
    }, signal, (_model, context) => requestModel(input, context, model, turnSignal(), session));
    signal.throwIfAborted();
    const message = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
    if (!message) throw new Error("AI 未返回结果");
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "AI 请求失败");
    if (definitions.length && message.stopReason === "length") throw new Error("模型输出达到上限，请精简任务后重试");
    if (message.content.some(part => part.type === "toolCall")) throw new Error("AI 已达到 40 轮调用上限，请缩小任务后重试");
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
    const reasoning = message.content.filter(part => part.type === "thinking").map(part => part.thinking).join("");
    return { text, ...(reasoning ? { reasoning } : {}) };
  }

  return { getModels, getMediaModels, generateImage, generateVideo, generateAudio, trainLora, generate };
}
