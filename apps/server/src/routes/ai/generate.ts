import { Router } from "express";
import { z } from "zod";
import type { Context, Message } from "@earendil-works/pi-ai";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";
import { translateError, translateMessage, validationOptions } from "@/lib/i18n";

const textPart = z.object({ type: z.literal("text"), text: z.string(), textSignature: z.string().optional() });
const imagePart = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string().startsWith("image/") });
const messageSchema: z.ZodType<Message> = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"), content: z.union([z.string(), z.array(z.union([textPart, imagePart])).max(1000)]),
    timestamp: z.number().nonnegative(),
  }),
  z.looseObject({
    role: z.literal("assistant"),
    content: z.array(z.discriminatedUnion("type", [
      textPart,
      z.object({ type: z.literal("thinking"), thinking: z.string(), thinkingSignature: z.string().optional(), redacted: z.boolean().optional() }),
      z.object({
        type: z.literal("toolCall"), id: z.string().min(1), name: z.string().min(1), arguments: z.record(z.string(), z.json()),
        thoughtSignature: z.string().optional(), namespace: z.string().optional(),
      }),
    ])).max(1000),
    api: z.string().min(1), provider: z.string().min(1), model: z.string().min(1), timestamp: z.number().nonnegative(),
    stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
    usage: z.looseObject({
      input: z.number().nonnegative(), output: z.number().nonnegative(), cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(),
      totalTokens: z.number().nonnegative(),
      cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }),
    }),
  }),
  z.looseObject({
    role: z.literal("toolResult"), toolCallId: z.string().min(1), toolName: z.string().min(1),
    content: z.array(z.union([textPart, imagePart])).max(1000), isError: z.boolean(), timestamp: z.number().nonnegative(),
  }),
]);

const contextSchema: z.ZodType<Context> = z.object({
  systemPrompt: z.string().max(100000).optional(),
  messages: z.array(messageSchema).min(1).max(2000),
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/),
    description: z.string().min(1).max(10000),
    parameters: z.record(z.string(), z.json()).refine(value => value.type === "object" && JSON.stringify(value).length <= 100000, "Tool parameters must be a JSON object structure and no larger than 100 KB"),
    constrainedSampling: z.union([
      z.literal(false),
      z.object({ type: z.literal("json_schema"), strict: z.enum(["prefer", "require"]) }),
      z.object({ type: z.literal("grammar"), variants: z.object({ openai_lark: z.string().optional(), openai_regex: z.string().optional() }) }),
    ]).optional(),
  })).max(32).refine(tools => new Set(tools.map(tool => tool.name)).size === tools.length, "Tool names cannot be repeated").optional(),
}).refine(context => Buffer.byteLength(JSON.stringify(context)) <= 8000000, "Model context cannot exceed 8 MB");

const inputSchema = z.object({
  providerId: z.string().min(1), modelId: z.string().min(1),
  context: contextSchema,
  directory: z.string().min(1).max(4096).optional(),
  references: z.array(u.ai.aiReferenceSchema).max(32).optional(),
  // A tool loop keeps one session ID so providers such as Claude Code can continue the same model process.
  session: z.uuid().optional(),
  // A JSON Schema the reply must fit, enforced by the Colab models' grammar sampling.
  responseSchema: z.record(z.string(), z.json()).refine(value => value.type === "object" && JSON.stringify(value).length <= 100000, "The response schema must be a JSON object structure and no larger than 100 KB").optional(),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  // Only Toonflow pages may spend the configured model subscriptions and API keys.
  u.mcpControl.assertAppRequest(req);
  const input = inputSchema.parse(req.body, validationOptions());
  const configured = u.ai.getConfiguredModel(input.providerId, input.modelId);
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => { clearInterval(heartbeat); controller.abort(); };
  // The response closes when the client disconnects, which cancels the upstream model call.
  res.once("close", close);
  try {
    const directory = input.references?.some(item => item.dataType !== "STRING")
      ? await u.workspace.resolveWorkspace(req, input.directory ?? "") : undefined;
    const references = await u.ai.readAiReferences(directory, input.references ?? [], controller.signal);
    const stream = await u.ai.streamAi(configured, input.context, controller.signal, references, input.session, input.responseSchema);
    res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(": keepalive\n\n");
    }, 20000);
    const send = (event: object) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      for await (const event of stream) {
        if (event.type === "text_delta" || event.type === "thinking_delta") {
          send({ type: event.type === "text_delta" ? "text" : "reasoning", delta: event.delta });
        }
      }
      const message = await stream.result();
      if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "Model request failed");
      send({ type: "done", message });
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? translateError(error) : translateMessage("Model request failed") });
    } finally {
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
    res.off("close", close);
  }
});
