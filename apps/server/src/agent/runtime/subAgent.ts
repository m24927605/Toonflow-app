import type { Usage } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolCall } from "@toonflow/tools-scaffold/runtime";
import { createAgentResources } from "@/agent/runtime/resources";

export type SubAgentModel = Pick<CreateAgentSessionOptions, "modelRuntime" | "model" | "thinkingLevel">;
export type SubAgentResult = {
  name: string;
  status: "running" | "completed" | "error" | "limited" | "cancelled" | "inputRequired";
  result: string;
  taskId?: string;
  contextId?: string;
};

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(total: Usage, value: Usage) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += value[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += value.cost[key];
}

export async function runSubAgent(options: SubAgentModel & {
  cwd: string;
  name: string;
  task: string;
  tools: ToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
  history?: SessionManager;
  inputRequired?: () => string | undefined;
  onTool?: (tool: ToolCall) => void;
  onProgress?: (message: string) => void;
}) {
  const { cwd, name, task, tools, instructions, signal = new AbortController().signal, history, inputRequired, onTool, onProgress, ...modelOptions } = options;
  const result: SubAgentResult = { name, status: "running", result: "Ready to execute" };
  const usage = emptyUsage();
  let session: AgentSession | undefined;
  const abort = () => { void session?.abort(); };
  signal.addEventListener("abort", abort, { once: true });
  // A2A task continuations reuse in-memory history; only sum records added this time to avoid double billing.
  const previousEntries = history?.getEntries().length ?? 0;
  try {
    signal.throwIfAborted();
    const activeTools = tools.map(tool => ({
      ...tool,
      async execute(...args: Parameters<ToolDefinition["execute"]>) {
        signal.throwIfAborted();
        // ACT: The SDK only stops the turn after the whole tool batch
        // finishes; once a question is asked, skip the rest of the batch.
        if (inputRequired?.()) throw new Error("The task is waiting for additional input from the caller and cannot continue to execute the tool.");
        if (tool.name !== "askUser" || !onTool) return tool.execute(...args);
        // Sub-session model call IDs may repeat, so question cards and answer channels use separate IDs.
        const id = crypto.randomUUID();
        onTool({ id, name: tool.name, args: args[1] as Record<string, unknown>, status: "running" });
        try {
          const output = await tool.execute(id, args[1], args[2], args[3], args[4]);
          onTool({ id, name: tool.name, status: "success", result: output.content.filter(part => part.type === "text").map(part => part.text).join("\n") });
          return output;
        } catch (error) {
          onTool({ id, name: tool.name, status: signal.aborted ? "interrupted" : "error", result: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    }));
    const resources = await createAgentResources(cwd, activeTools, SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }), instructions);
    signal.throwIfAborted();
    ({ session } = await createAgentSession({
      ...modelOptions, ...resources, cwd,
      sessionManager: history ?? SessionManager.inMemory(cwd),
      customTools: activeTools,
      tools: activeTools.map(tool => tool.name),
    }));
    signal.throwIfAborted();
    session.agent.finishTurn = () => inputRequired?.() ? { action: "end" } : undefined;
    session.subscribe(event => {
      if (signal.aborted) return;
      if (event.type === "message_start" && event.message.role === "assistant") onProgress?.("is being processed");
      if (event.type === "tool_execution_start") onProgress?.(`Calling ${event.toolName}`);
    });
    await session.prompt(`You are performing a delegated independent subtask. Handle only the task below and follow the authorization and workspace rules in the system. If information or authorization is missing, explain the blocker and hand it back to the caller; if requestInput is provided, use it to wait for more input. Finally return a concise conclusion, the relative paths of files actually modified, verification status and unfinished items; write long deliverables to authorized workspace files.

${JSON.stringify({ name, task })}`, { expandPromptTemplates: false });
    signal.throwIfAborted();
    const question = inputRequired?.();
    const reply = session.messages.findLast(message => message.role === "assistant");
    if (!reply || reply.role !== "assistant") throw new Error("The subtask did not return a reply");
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage || "Subtask execution failed");
    const text = question ?? reply.content.filter(part => part.type === "text").map(part => part.text).join("\n").trim();
    if (!text) throw new Error("Subtask did not return text result");
    result.status = question ? "inputRequired" : reply.stopReason === "length" || text.length > 16000 ? "limited" : "completed";
    result.result = `${text.slice(0, 16000)}${text.length > 16000 ? "\n[Result too long and truncated; read the output files in the workspace]" : ""}${reply.stopReason === "length" ? "\n[Model output reached the length limit; the task may be incomplete]" : ""}`.trim();
  } catch (error) {
    result.status = signal.aborted ? "cancelled" : "error";
    const reason = signal.aborted ? signal.reason : error;
    result.result = reason instanceof Error ? reason.message : "Subtask execution failed";
  } finally {
    signal.removeEventListener("abort", abort);
    if (session) {
      try {
        await session.abort();
        for (const entry of session.sessionManager.getEntries().slice(previousEntries)) {
          if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult") && entry.message.usage) addUsage(usage, entry.message.usage);
        }
      } finally { session.dispose(); }
    }
  }
  return { result, usage };
}
