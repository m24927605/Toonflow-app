import { randomUUID } from "node:crypto";
import { Router, json, type Request } from "express";
import { AgentCard, Message, Task, TaskState, Role, type Artifact } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus } from "@a2a-js/sdk/server";
import { jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import { RequestMalformedError, TaskNotCancelableError } from "@a2a-js/sdk/errors";
import { teamSchema, type TeamManifest } from "./runtime";

export { AgentCard, Artifact, Message, Task, TaskState, Role, SendMessageRequest, GetTaskRequest, CancelTaskRequest } from "@a2a-js/sdk";

export type TeamA2aEvent =
  | { type: "status"; text: string }
  | { type: "artifact"; artifact: Artifact; append?: boolean; lastChunk?: boolean };

export type TeamA2aRequest = {
  taskId: string;
  contextId: string;
  message: Message;
  task?: Task;
  userId: string;
  signal: AbortSignal;
  emit(event: TeamA2aEvent): void;
};

export type TeamA2aResult = { status: "completed" | "inputRequired"; text: string; artifacts?: Artifact[] };

export function createTeamAgentCard(manifest: TeamManifest, endpointUrl: string): AgentCard {
  const team = teamSchema.parse(manifest);
  const endpoint = new URL(endpointUrl);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) throw new Error("A2A address must be an HTTP(S) address without embedded credentials");
  return AgentCard.fromJSON({
    name: team.displayName,
    description: team.description,
    version: team.version,
    supportedInterfaces: [{ url: endpoint.href.replace(/\/$/, ""), protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    ...(team.github ? { provider: { organization: team.author, url: team.github }, documentationUrl: team.github } : {}),
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
    securityRequirements: [{ schemes: { bearer: [] } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain", "application/json"],
    // Team capabilities and the team's private SKILL.md are different resources;
    // the Card does not publish member prompts or private material.
    skills: [{ id: team.name, name: team.displayName, description: team.description, tags: ["toonflow", "team"] }],
  });
}

export function createTeamA2aRouter(options: {
  card: AgentCard;
  execute(request: TeamA2aRequest): Promise<TeamA2aResult>;
  authenticate(request: Request): string | undefined | Promise<string | undefined>;
  onCancel?(taskId: string): void | Promise<void>;
}) {
  const router = Router();
  const identities = new WeakMap<Request, string>();
  const active = new Map<string, { userId: string; controller: AbortController; done: Promise<void> }>();
  const paused = new Map<string, string>();
  const message = (taskId: string, contextId: string, text: string) => Message.fromJSON({
    messageId: randomUUID(), taskId, contextId, role: Role.ROLE_AGENT, parts: [{ text, mediaType: "text/plain" }],
  });
  const status = (bus: ExecutionEventBus, taskId: string, contextId: string, state: TaskState, text: string) => {
    bus.publish(AgentEvent.statusUpdate({ taskId, contextId, status: { state, message: message(taskId, contextId, text), timestamp: new Date().toISOString() }, metadata: undefined }));
  };
  const executor: AgentExecutor = {
    async execute(context, bus) {
      const { taskId, contextId } = context;
      const userId = context.context.user?.userName;
      if (!userId) throw new Error("A2A request is missing an authenticated identity");
      if (active.has(taskId)) throw new RequestMalformedError("The same task is running; wait for the current run to finish");
      const controller = new AbortController();
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      active.set(taskId, { userId, controller, done });
      paused.delete(taskId);
      const task = context.task ? structuredClone(context.task) : Task.fromJSON({ id: taskId, contextId, history: [Message.toJSON(context.userMessage)] });
      task.status = { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() };
      bus.publish(AgentEvent.task(task));
      const emit = (event: TeamA2aEvent) => {
        controller.signal.throwIfAborted();
        if (event.type === "status") status(bus, taskId, contextId, TaskState.TASK_STATE_WORKING, event.text);
        else bus.publish(AgentEvent.artifactUpdate({ taskId, contextId, artifact: event.artifact, append: event.append ?? false, lastChunk: event.lastChunk ?? true, metadata: undefined }));
      };
      try {
        const result = await options.execute({ taskId, contextId, message: context.userMessage, task: context.task, userId, signal: controller.signal, emit });
        controller.signal.throwIfAborted();
        for (const artifact of result.artifacts ?? []) emit({ type: "artifact", artifact });
        if (result.status === "inputRequired") paused.set(taskId, contextId);
        status(bus, taskId, contextId, result.status === "inputRequired" ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_COMPLETED, result.text);
      } catch (error) {
        status(bus, taskId, contextId, controller.signal.aborted ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : "Team execution failed");
      } finally {
        active.delete(taskId);
        finish();
      }
    },
    async cancelTask(taskId, bus) {
      const running = active.get(taskId);
      if (!running) {
        const contextId = paused.get(taskId);
        if (!contextId) throw new TaskNotCancelableError("The task has no work currently running");
        status(bus, taskId, contextId, TaskState.TASK_STATE_CANCELED, "Task cancelled");
        paused.delete(taskId);
        return;
      }
      running.controller.abort(new Error("Task cancelled"));
      // execute publishes CANCELED only after the host cleans up concurrent members;
      // a cancel request must not pass for execution having stopped.
      await running.done;
    },
  };
  // ACT: The SDK's task store and owner isolation reuse the in-memory implementation;
  // tasks are not restored after a server restart.
  // INPUT_REQUIRED ends the current stream; the next message carrying the taskId re-enters execute from the SDK store.
  const handler = new DefaultRequestHandler(options.card, new InMemoryTaskStore(), executor, undefined, undefined, undefined, undefined, undefined, { keepBusAliveStates: [] });
  const cancelTask = handler.cancelTask.bind(handler);
  handler.cancelTask = async (request, context) => {
    const task = await cancelTask(request, context);
    paused.delete(task.id);
    await options.onCancel?.(task.id);
    return task;
  };
  // Reject repeat submissions by the same owner for a running task,
  // so the SDK does not record the duplicate-execution error as the original task failing.
  const pending = new Set<string>();
  function begin(taskId: string | undefined, userId: string | undefined) {
    if (!taskId) return;
    const key = JSON.stringify([userId, taskId]);
    if (pending.has(key) || active.get(taskId)?.userId === userId) throw new RequestMalformedError("The same task is running; wait for the current run to finish");
    pending.add(key);
    return key;
  }
  const sendMessage = handler.sendMessage.bind(handler);
  handler.sendMessage = async (request, context) => {
    const key = begin(request.message?.taskId, context.user?.userName);
    try { return await sendMessage(request, context); }
    finally { if (key) pending.delete(key); }
  };
  const sendMessageStream = handler.sendMessageStream.bind(handler);
  handler.sendMessageStream = async function* (request, context) {
    const key = begin(request.message?.taskId, context.user?.userName);
    try { yield* sendMessageStream(request, context); }
    finally { if (key) pending.delete(key); }
  };
  // SDK 1.2's Card middleware stringifies the internal oneof directly; use the official ProtoJSON serialization here.
  router.get("/.well-known/agent-card.json", async (_request, response, next) => {
    try { response.json(AgentCard.toJSON(await handler.getAgentCard())); }
    catch (error) { next(error); }
  });
  router.use(async (request, response, next) => {
    try {
      const userId = await options.authenticate(request);
      if (!userId) {
        response.set("WWW-Authenticate", "Bearer").status(401).json({ error: "unauthorized" });
        return;
      }
      identities.set(request, userId);
      next();
    } catch (error) { next(error); }
  });
  router.use(json({ limit: "2mb" }));
  router.use(jsonRpcHandler({
    requestHandler: handler,
    userBuilder: async request => ({ isAuthenticated: true, userName: identities.get(request)! }),
  }));
  return router;
}

export async function createTeamA2aClient(options: { url: string; token?: string; fetch?: typeof fetch }) {
  const cardUrl = new URL(options.url);
  if (!["http:", "https:"].includes(cardUrl.protocol) || cardUrl.username || cardUrl.password || cardUrl.hash) throw new Error("Agent Card address must be an HTTP(S) address without embedded credentials");
  const originalFetch = options.fetch ?? globalThis.fetch;
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof globalThis.Request ? input.url : String(input));
    if (options.token && url.origin !== cardUrl.origin) throw new Error("Cannot forward the A2A key to another origin in the Agent Card");
    const headers = new Headers(input instanceof globalThis.Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
    return originalFetch(input, { ...init, headers, redirect: "error" });
  }) as typeof fetch;
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl }), new RestTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  return factory.createFromUrl(cardUrl.href, "");
}
