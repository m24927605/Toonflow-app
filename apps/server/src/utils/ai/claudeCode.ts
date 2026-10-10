import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { mkdtemp, rm, writeFile } from "@toonflow/file";
import { findCommand } from "@/utils/cli";

/** Runs the locally signed-in Claude Code CLI for single-turn text generation; attachments are Anthropic content blocks. */
export async function streamClaudeCode(providerId: string, modelId: string, context: Context, signal: AbortSignal, attachments: object[]) {
  if (!/^[\w.[\]-]+$/.test(modelId)) throw Object.assign(new Error("Claude Code 模型 ID 无效"), { status: 400 });
  if (context.tools?.length) throw Object.assign(new Error("Claude Code 不支持工具调用，请改用其他模型"), { status: 400 });
  const [message, ...rest] = context.messages;
  if (rest.length || message?.role !== "user") throw Object.assign(new Error("Claude Code 仅支持单轮文本生成"), { status: 400 });
  const content = [
    ...(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content.map(part => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } })),
    ...attachments,
  ];
  const command = findCommand("claude", "未找到 Claude Code，请先在运行 Toonflow 的电脑上安装并登录 Claude Code");
  // Free text never goes into argv: on Windows an npm `.cmd` shim runs through cmd.exe, which would re-parse it.
  // The prompt goes through stdin and the system prompt through a temporary file.
  const directory = await mkdtemp(join(tmpdir(), "toonflow-claude-"));
  const systemPromptPath = join(directory, "systemPrompt.md");
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    if (context.systemPrompt) await writeFile(systemPromptPath, context.systemPrompt);
    // ACT: Disable tools, MCP, user settings and CLAUDE.md so the CLI only acts as a model call; sessions are not
    // persisted, and telemetry/error reporting (non-essential traffic) is turned off.
    child = Bun.spawn([
      command, "-p", "--input-format=stream-json", "--output-format=stream-json", "--verbose", "--include-partial-messages",
      "--tools=", "--strict-mcp-config", "--setting-sources=", "--no-session-persistence", `--model=${modelId}`,
      ...(context.systemPrompt ? [`--system-prompt-file=${systemPromptPath}`] : []),
    ], { cwd: tmpdir(), env: { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, stdin: "pipe", stdout: "pipe", stderr: "pipe", signal });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  child.stdin.end();

  const output: AssistantMessage = {
    role: "assistant", content: [], api: "claude-code", provider: providerId, model: modelId, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: output });
  void (async () => {
    const stderr = new Response(child.stderr).text();
    let result: { is_error?: boolean; result?: string; stop_reason?: string; usage?: Record<string, number> } | undefined;
    let buffer = "";
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "result") result = event;
        if (event.type !== "stream_event") continue;
        const block = event.event?.content_block;
        if (event.event?.type === "content_block_start" && (block?.type === "text" || block?.type === "thinking")) {
          output.content.push(block.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
        }
        const delta = event.event?.delta;
        const part = output.content.at(-1);
        if (event.event?.type !== "content_block_delta" || !part) continue;
        const contentIndex = output.content.length - 1;
        if (delta?.type === "text_delta" && part.type === "text") {
          part.text += delta.text;
          stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
        } else if (delta?.type === "thinking_delta" && part.type === "thinking") {
          part.thinking += delta.thinking;
          stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
        }
      }
    }
    await child.exited;
    if (signal.aborted || !result || result.is_error) {
      const reason = signal.aborted ? "aborted" : "error";
      const errorMessage = signal.aborted ? "已取消" : result?.result || (await stderr).trim() || `Claude Code 异常退出（${child.exitCode}）`;
      stream.push({ type: "error", reason, error: { ...output, stopReason: reason, errorMessage } });
      return;
    }
    const usage = result.usage ?? {};
    output.usage = { ...output.usage, input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
    output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    const reason = result.stop_reason === "max_tokens" ? "length" : "stop";
    output.stopReason = reason;
    stream.push({ type: "done", reason, message: output });
  })().catch((error: unknown) => {
    child.kill();
    stream.push({ type: "error", reason: "error", error: { ...output, stopReason: "error", errorMessage: error instanceof Error ? error.message : "Claude Code 输出无法解析" } });
  }).finally(() => rm(directory, { recursive: true, force: true }).catch(() => {}));
  return stream;
}
