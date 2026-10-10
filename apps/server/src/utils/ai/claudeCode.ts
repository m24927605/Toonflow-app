import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "express";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type JsonObject, type ToolCall } from "@earendil-works/pi-ai";
import { createMcpRouter } from "@toonflow/mcp";
import { mkdtemp, rm, writeFile } from "@toonflow/file";
import { findCommand } from "@/utils/cli";
import { getMcpRuntime } from "@/utils/mcp/runtime";

type Block = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type Part = Context["messages"][number] extends infer M ? M extends { content: infer C } ? C extends (infer P)[] ? P : never : never : never;
type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError: boolean };

/**
 * One CLI process serves a whole tool loop: Claude keeps its own reasoning between turns, the tools are real MCP
 * tools, and each tool call waits until the next turn brings the result that the page executed.
 */
type Session = {
  id?: string;
  model: string;
  token: string;
  directory: string;
  child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  lines: AsyncGenerator<string>;
  stderr: Promise<string>;
  mcp?: ReturnType<typeof createMcpRouter>;
  /** Context messages the CLI already has, counting the reply of the current turn. */
  delivered: number;
  /** tool_use id → call key, for matching the results of the next turn. */
  calls: Map<string, string>;
  waiting: { key: string; resolve(result: ToolResult): void }[];
  ready: { key: string; result: ToolResult }[];
  idle?: ReturnType<typeof setTimeout>;
};

const toolPrefix = "mcp__toonflow__";
const sessions = new Map<string, Session>();
const bridges = new Map<string, Session>();

function blocks(content: string | Part[]): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.flatMap((part): Block[] => part.type === "text" ? [{ type: "text", text: part.text }]
    : part.type === "image" ? [{ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } }] : []);
}

/** The CLI and the page see the same call; keys ignore property order so both sides match. */
function callKey(name: string, args: unknown) {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort((value as Record<string, unknown>)[key])])) : value;
  return `${name}:${JSON.stringify(sort(args))}`;
}

function deliver(session: Session, key: string, result: ToolResult) {
  const index = session.waiting.findIndex(item => item.key === key);
  if (index < 0) session.ready.push({ key, result });
  else session.waiting.splice(index, 1)[0]!.resolve(result);
}

function waitForResult(session: Session, key: string) {
  const index = session.ready.findIndex(item => item.key === key);
  if (index >= 0) return Promise.resolve(session.ready.splice(index, 1)[0]!.result);
  return new Promise<ToolResult>(resolve => session.waiting.push({ key, resolve }));
}

function closeSession(session: Session) {
  clearTimeout(session.idle);
  if (session.id && sessions.get(session.id) === session) sessions.delete(session.id);
  bridges.delete(session.token);
  session.child.kill();
  for (const item of session.waiting.splice(0)) item.resolve({ isError: true, content: [{ type: "text", text: "Claude Code 会话已结束" }] });
  void session.mcp?.close();
  void rm(session.directory, { recursive: true, force: true }).catch(() => {});
}

async function* readLines(stream: Session["child"]["stdout"]) {
  let buffer = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    const lines = (buffer + chunk).split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield line;
  }
}

function send(session: Session, content: object[], last: boolean) {
  session.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  if (last) session.child.stdin.end();
  else session.child.stdin.flush();
}

async function startSession(modelId: string, context: Context, id?: string) {
  const tools = context.tools ?? [];
  const command = findCommand("claude", "未找到 Claude Code，请先在运行 Toonflow 的电脑上安装并登录 Claude Code");
  const origin = getMcpRuntime().appOrigin;
  if (tools.length && !origin) throw new Error("服务尚未就绪，请稍后重试");
  // Free text never goes into argv: on Windows an npm `.cmd` shim runs through cmd.exe, which would re-parse it.
  // The prompt goes through stdin; the system prompt and the MCP config (with its token) go through private temporary files.
  const directory = await mkdtemp(join(tmpdir(), "toonflow-claude-"));
  const token = randomBytes(32).toString("hex");
  try {
    const args = [command, "-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose", "--include-partial-messages",
      "--tools=", "--strict-mcp-config", "--setting-sources=", "--no-session-persistence", `--model=${modelId}`];
    if (context.systemPrompt) {
      await writeFile(join(directory, "systemPrompt.md"), context.systemPrompt);
      args.push(`--system-prompt-file=${join(directory, "systemPrompt.md")}`);
    }
    if (tools.length) {
      const config = { mcpServers: { toonflow: { type: "http", url: `${origin}/claudeCode/mcp`, headers: { Authorization: `Bearer ${token}` } } } };
      await writeFile(join(directory, "mcp.json"), JSON.stringify(config));
      args.push(`--mcp-config=${join(directory, "mcp.json")}`, "--allowedTools=mcp__toonflow");
    }
    // ACT: Built-in tools, other MCP servers, user settings and CLAUDE.md stay off so the CLI only reaches the page's
    // tools; sessions are not persisted, and telemetry/error reporting (non-essential traffic) is turned off.
    const child = Bun.spawn(args, {
      cwd: tmpdir(), env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const session: Session = {
      id, model: modelId, token, directory, child, lines: readLines(child.stdout), stderr: new Response(child.stderr).text(),
      delivered: 0, calls: new Map(), waiting: [], ready: [],
    };
    if (tools.length) {
      session.mcp = createMcpRouter({
        // The bridge router below already matched this session's token.
        authorize: () => true,
        getTools: async () => tools.map(tool => ({
          name: tool.name, description: tool.description, inputSchema: tool.parameters as Record<string, unknown>,
          execute: args => waitForResult(session, callKey(tool.name, args)),
        })),
      });
      bridges.set(token, session);
      if (id) sessions.set(id, session);
    }
    return session;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** MCP endpoint the CLI calls for tools; only local processes holding a live session token get through. */
export const claudeCodeToolsRouter = Router().use((request, response, next) => {
  const token = /^Bearer ([\da-f]{64})$/.exec(request.get("authorization") ?? "")?.[1];
  const session = token ? bridges.get(token) : undefined;
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
  if (!local || !session?.mcp) {
    response.status(401).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Claude Code 会话不存在" } });
    return;
  }
  session.mcp(request, response, next);
});

function readTurn(session: Session, providerId: string, modelId: string, signal: AbortSignal) {
  const output: AssistantMessage = {
    role: "assistant", content: [], api: "claude-code", provider: providerId, model: modelId, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: output });
  const abort = () => closeSession(session);
  signal.addEventListener("abort", abort, { once: true });
  void (async () => {
    const calls: ToolCall[] = [];
    for (;;) {
      const { value: line, done } = await session.lines.next();
      if (done) throw new Error(signal.aborted ? "已取消" : (await session.stderr).trim() || `Claude Code 异常退出（${session.child.exitCode}）`);
      const event = JSON.parse(line);
      if (event.type === "assistant") {
        // The CLI reports each finished content block; tool calls run as soon as their block is complete.
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_use" || typeof block.name !== "string" || !block.name.startsWith(toolPrefix)) continue;
          const name = block.name.slice(toolPrefix.length);
          session.calls.set(block.id, callKey(name, block.input));
          calls.push({ type: "toolCall", id: block.id, name, arguments: block.input as JsonObject });
        }
      } else if (event.type === "result") {
        if (event.is_error) throw new Error(event.result || "Claude Code 请求失败");
        const usage = event.usage ?? {};
        output.usage = { ...output.usage, input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
        output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        output.stopReason = event.stop_reason === "max_tokens" ? "length" : "stop";
        stream.push({ type: "done", reason: output.stopReason, message: output });
        closeSession(session);
        return;
      } else if (event.type === "stream_event") {
        const streamEvent = event.event;
        const block = streamEvent?.content_block;
        if (streamEvent?.type === "content_block_start" && (block?.type === "text" || block?.type === "thinking")) {
          output.content.push(block.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        } else if (streamEvent?.type === "content_block_delta") {
          const delta = streamEvent.delta;
          const part = output.content.at(-1);
          const contentIndex = output.content.length - 1;
          if (delta?.type === "text_delta" && part?.type === "text") {
            part.text += delta.text;
            stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
          } else if (delta?.type === "thinking_delta" && part?.type === "thinking") {
            part.thinking += delta.thinking;
            stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
          }
        } else if (streamEvent?.type === "message_stop" && calls.length) {
          // The turn ends here; the CLI keeps waiting on the calls until the next turn brings their results.
          output.content.push(...calls);
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          session.idle = setTimeout(() => closeSession(session), 600000);
          return;
        }
      }
    }
  })().catch((error: unknown) => {
    closeSession(session);
    const reason = signal.aborted ? "aborted" : "error";
    stream.push({ type: "error", reason, error: { ...output, stopReason: reason, errorMessage: error instanceof Error ? error.message : "Claude Code 输出无法解析" } });
  }).finally(() => signal.removeEventListener("abort", abort));
  return stream;
}

/**
 * Runs the locally signed-in Claude Code CLI as a model call; attachments are Anthropic content blocks. Requests with
 * tools need the page's session ID: the first turn starts the CLI, and later turns only bring the tool results.
 */
export async function streamClaudeCode(providerId: string, modelId: string, context: Context, signal: AbortSignal, attachments: object[], sessionId?: string) {
  if (!/^[\w.[\]-]+$/.test(modelId)) throw Object.assign(new Error("Claude Code 模型 ID 无效"), { status: 400 });
  const tools = context.tools ?? [];
  if (tools.length && !sessionId) throw Object.assign(new Error("Claude Code 工具调用需要会话 ID"), { status: 400 });
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    const [first, ...rest] = context.messages;
    if (!first || first.role !== "user") throw Object.assign(new Error("Claude Code 请求必须以用户消息开始"), { status: 400 });
    if (rest.length) throw Object.assign(new Error("Claude Code 会话已结束，请重新生成"), { status: 409 });
    session = await startSession(modelId, context, sessionId);
    send(session, [...blocks(first.content), ...attachments], !tools.length);
  } else {
    clearTimeout(session.idle);
    const results = context.messages.slice(session.delivered);
    if (session.model !== modelId || !results.length || results.some(message => message.role !== "toolResult" || !session!.calls.has(message.toolCallId))) {
      closeSession(session);
      throw Object.assign(new Error("Claude Code 会话只能继续提交本轮工具结果，请重新生成"), { status: 409 });
    }
    for (const message of results) {
      if (message.role !== "toolResult") continue;
      deliver(session, session.calls.get(message.toolCallId)!, {
        isError: message.isError,
        content: message.content.map(part => part.type === "image" ? { type: "image", data: part.data, mimeType: part.mimeType } : { type: "text", text: part.text }),
      });
    }
  }
  session.delivered = context.messages.length + 1;
  return readTurn(session, providerId, modelId, signal);
}
