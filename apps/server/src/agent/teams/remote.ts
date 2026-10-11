import { t } from "@/lib/i18n";
import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import { createTeamA2aClient, SendMessageRequest, GetTaskRequest, CancelTaskRequest, TaskState, Role, type Message, type Task, type Artifact } from "@toonflow/teams-scaffold/a2a";
import { emptyUsage, type SubAgentResult } from "@/agent/runtime/subAgent";
import { getRemoteTeam } from "@/utils/teams";

export async function runRemoteTeam(options: {
  name: string;
  task: string;
  taskId?: string;
  contextId?: string;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}): Promise<{ result: SubAgentResult; usage: Usage }> {
  const { name, task, signal, onProgress } = options;
  const result: SubAgentResult = { name, status: "running", result: "Prepare to connect to the remote team", taskId: options.taskId, contextId: options.contextId };
  const artifacts = new Map<string, string>();
  let client: Awaited<ReturnType<typeof createTeamA2aClient>> | undefined;
  let sent = false;
  let state: TaskState | undefined;
  let text = "";
  let directReply = false;
  let truncated = false;

  function limit(value: string) {
    if (value.length > 16000) truncated = true;
    return value.slice(0, 16000);
  }
  function partsText(parts: Message["parts"]) {
    return limit(parts.map(part => {
      const content = part.content;
      if (content?.$case === "text") return content.value;
      if (content?.$case === "data") return JSON.stringify(content.value);
      if (content?.$case === "url") return `Remote file ${part.filename ? ` ${part.filename}` : ""}: ${content.value}`;
      if (content?.$case === "raw") return `Remote attachment ${part.filename ? ` ${part.filename}` : ""} (${content.value.byteLength} bytes, not saved to the workspace)`;
      return "";
    }).filter(Boolean).join("\n"));
  }
  function identify(taskId?: string, contextId?: string) {
    if ((taskId && result.taskId && taskId !== result.taskId) || (contextId && result.contextId && contextId !== result.contextId)) throw new Error("The task ID returned by the remote end does not match");
    if (taskId) result.taskId = taskId;
    if (contextId) result.contextId = contextId;
  }
  function artifact(value: Artifact, append = false) {
    // ACT: The tool returns only bounded text and file descriptions; it
    // neither downloads URLs nor writes remote attachments into the workspace.
    if (!artifacts.has(value.artifactId) && artifacts.size >= 128) { truncated = true; return; }
    artifacts.set(value.artifactId, limit(`${append ? artifacts.get(value.artifactId) ?? "" : ""}${partsText(value.parts)}`));
  }
  function status(value: Task["status"]) {
    if (!value) return;
    state = value.state;
    const update = value.message ? partsText(value.message.parts) : "";
    if (update) text = update;
    if (state === TaskState.TASK_STATE_WORKING || state === TaskState.TASK_STATE_SUBMITTED) onProgress?.(update || "The remote team is executing");
  }
  function snapshot(value: Task) {
    identify(value.id, value.contextId);
    artifacts.clear();
    for (const item of value.artifacts) artifact(item);
    const reply = value.history.findLast(item => item.role === Role.ROLE_AGENT);
    text = reply ? partsText(reply.parts) : "";
    status(value.status);
  }
  function finish() {
    if (state === TaskState.TASK_STATE_COMPLETED || (state === undefined && directReply)) result.status = "completed";
    else if (state === TaskState.TASK_STATE_CANCELED) result.status = "cancelled";
    else if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED) result.status = "inputRequired";
    else if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED) result.status = "error";
    else return false;
    result.result = limit([...new Set([text, ...artifacts.values()].filter(Boolean))].join("\n\n")) || (
      result.status === "completed" ? "The remote task completed without returning text output" :
      result.status === "cancelled" ? "The remote task has been confirmed to be canceled." :
      state === TaskState.TASK_STATE_AUTH_REQUIRED ? "The remote task requires additional authentication, please let the user handle it before continuing." :
      result.status === "inputRequired" ? "The remote task requires supplementary information" : "The remote task failed or was rejected"
    );
    if (truncated) {
      if (result.status === "completed") result.status = "limited";
      result.result += "\n[Remote result too long and truncated; use taskId to retrieve the complete output]";
    }
    return true;
  }

  try {
    signal?.throwIfAborted();
    const remote = getRemoteTeam(name);
    if (!remote) throw new Error(t`Remote team ${name} does not exist`);
    if (!remote.enabled) throw new Error(t`Remote Team ${name} Disabled`);
    client = await createTeamA2aClient({
      url: remote.cardUrl, token: remote.token,
      fetch: ((input, init) => fetch(input, { ...init, signal: init?.signal ?? signal })) as typeof fetch,
    });
    const card = await client.getAgentCard({ signal });
    signal?.throwIfAborted();
    if (!getRemoteTeam(name)?.enabled) throw new Error(t`Remote Team ${name} Disabled`);
    const request = SendMessageRequest.fromJSON({ message: {
      messageId: randomUUID(), role: "ROLE_USER", parts: [{ text: task }], taskId: result.taskId, contextId: result.contextId,
    } });
    sent = true;
    if (card.capabilities?.streaming) {
      for await (const event of client.sendMessageStream(request, { signal })) {
        const payload = event.payload;
        if (!payload) continue;
        if (payload.$case === "task") snapshot(payload.value);
        else if (payload.$case === "message") {
          identify(payload.value.taskId, payload.value.contextId);
          text = partsText(payload.value.parts);
          directReply = true;
        } else {
          identify(payload.value.taskId, payload.value.contextId);
          if (payload.$case === "statusUpdate") status(payload.value.status);
          else if (payload.value.artifact) artifact(payload.value.artifact, payload.value.append);
        }
      }
    } else {
      const reply = await client.sendMessage(request, { signal });
      if ("id" in reply) snapshot(reply);
      else { identify(reply.taskId, reply.contextId); text = partsText(reply.parts); directReply = true; }
    }
    signal?.throwIfAborted();
    if (!finish()) throw new Error("The remote response ends but does not return completion, failure or waiting for input status");
  } catch (error) {
    const reason = signal?.aborted ? signal.reason : error;
    const description = reason instanceof Error ? reason.message : String(reason ?? "Remote call failed");
    result.status = "error";
    result.result = description;
    if (client && (sent || options.taskId) && result.taskId) {
      try {
        if (signal?.aborted) {
          const cancelled = await client.cancelTask(CancelTaskRequest.fromJSON({ id: result.taskId }), { signal: AbortSignal.timeout(15000) });
          snapshot(cancelled);
          if (state !== TaskState.TASK_STATE_CANCELED) throw new Error("The remote end did not confirm the cancellation.");
          result.status = "cancelled";
          result.result = `${description}; the remote side confirmed cancellation`;
        } else {
          // On stream loss only check the task without resending the message, to avoid repeating work with side effects.
          snapshot(await client.getTask(GetTaskRequest.fromJSON({ id: result.taskId }), { signal: AbortSignal.timeout(15000) }));
          if (!finish()) result.result = `${description}; the remote task has not finished yet and was not automatically retried or cancelled`;
        }
      } catch (checkError) {
        result.status = "error";
        result.result = `${description}; ${signal?.aborted ? "Unable to confirm cancellation of the remote task" : "Unable to confirm remote task status"}: ${checkError instanceof Error ? checkError.message : String(checkError)}`;
      }
    } else if (signal?.aborted && !sent) {
      if (result.taskId) result.result += "; this request has not been submitted, and the original remote task has not been canceled";
      else result.status = "cancelled";
    } else if (sent) result.result += "; The task ID has not been obtained, the remote status is unknown, and it has not been automatically retried.";
  }
  return { result, usage: emptyUsage() };
}
