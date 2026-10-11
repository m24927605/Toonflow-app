import { Router } from "express";
import { Artifact, createTeamAgentCard, createTeamA2aRouter, type TeamA2aRequest } from "@toonflow/teams-scaffold/a2a";
import { teamNameSchema } from "@toonflow/teams-scaffold/runtime";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import { createAgentModel } from "@/agent/runtime/model";
import { createAgentTools } from "@/agent/tools";
import { createTeamRunner } from "@/agent/teams";
import { readTeam } from "@/utils/teams";
import { callControl, getConnection } from "@/utils/mcp/control";
import { authenticateA2a, getA2aSettings, getA2aSignal, getA2aUrl, resolveA2aWorkspace } from "./settings";

export function createA2aRouter() {
  const router = Router();
  const endpoints = new Map<string, { router: Router; card: ReturnType<typeof createTeamAgentCard>; signal: AbortSignal }>();
  router.use("/:name", async (req, res, next) => {
    try {
      if (!getA2aSettings().enabled) { res.sendStatus(404); return; }
      const name = teamNameSchema.parse(req.params.name);
      const configurationSignal = getA2aSignal();
      let endpoint = endpoints.get(name);
      // Queries and cancellation of accepted tasks still go to the SDK;
      // disabling/uninstalling only stops execute from accepting new messages.
      if (endpoint?.signal === configurationSignal && req.method === "POST") { endpoint.router(req, res, next); return; }
      const team = await readTeam(name);
      if (!team.enabled) { res.sendStatus(404); return; }
      const card = createTeamAgentCard(team.manifest, `${getA2aUrl(req)}/${name}`);
      if (!endpoint || endpoint.signal !== configurationSignal) {
        // ACT: The SDK keeps tasks in single-process memory; only coordinators awaiting
        // more input also keep the Pi context. Tasks must be resubmitted after a restart.
        const pending = new Map<string, { runner: Awaited<ReturnType<typeof createTeamRunner>>; userId: string }>();
        const execute = async (request: TeamA2aRequest) => {
          try {
            const signal = AbortSignal.any([request.signal, configurationSignal]);
            signal.throwIfAborted();
            if (!(await readTeam(name)).enabled) throw new Error("The team is disabled and cannot receive new messages");
            if (request.message.parts.some(part => part.content?.$case !== "text")) throw new Error("This team endpoint accepts text only and does not download remote attachments. Provide relative paths within an authorized workspace in the text");
            const task = request.message.parts.map(part => part.content?.$case === "text" ? part.content.value : "").join("\n").trim();
            if (!task || task.length > 24000) throw new Error("Team task text should be 1 to 24000 characters");
            let current = pending.get(request.taskId);
            if (current && current.userId !== request.userId) throw new Error("The task does not belong to the current caller");
            if (request.task && !current) throw new Error("The task context has been released, please create a new task");
            if (!current) {
              const settings = getA2aSettings();
              const cwd = await resolveA2aWorkspace();
              // The directory was normalized on save; do not allow it to be
              // replaced with a link to another location before running.
              if (cwd !== settings.directory) throw new Error("The A2A working directory has changed, please re-authorize it in the settings");
              const { runtime } = await createAgentModel(settings.providerId, settings.modelId, settings.thinkingLevel);
              const connection = getConnection(undefined, cwd);
              const canvas: CanvasContext | undefined = connection ? {
                id: connection.state.canvasId ?? "a2a", tools: connection.state.tools,
                call: (call, callSignal) => callControl(connection.id, call.name, call.args, callSignal ?? signal, cwd),
              } : undefined;
              const tools = await createAgentTools(cwd, canvas);
              current = { userId: request.userId, runner: await createTeamRunner({
                name, cwd, tools, canvas, modelRuntime: runtime,
                model: runtime.getModel(settings.providerId, settings.modelId), thinkingLevel: settings.thinkingLevel,
              }) };
              pending.set(request.taskId, current);
            }
            const { result } = await current.runner.run(task, signal, text => request.emit({ type: "status", text }), true);
            signal.throwIfAborted();
            if (result.status === "inputRequired") return { status: "inputRequired" as const, text: result.result };
            pending.delete(request.taskId);
            if (result.status !== "completed") throw new Error(result.result || "The team has not completed the task");
            return { status: "completed" as const, text: result.result, artifacts: [Artifact.fromJSON({
              artifactId: request.taskId, name: "Team Results", parts: [{ text: result.result, mediaType: "text/plain" }],
            })] };
          } catch (error) { pending.delete(request.taskId); throw error; }
        };
        endpoint = { card, signal: configurationSignal, router: createTeamA2aRouter({
          card, authenticate: authenticateA2a, execute,
          onCancel: taskId => { pending.delete(taskId); },
        }) };
        endpoints.set(name, endpoint);
        configurationSignal.addEventListener("abort", () => { pending.clear(); endpoints.delete(name); }, { once: true });
      } else Object.assign(endpoint.card, card);
      endpoint.router(req, res, next);
    } catch (error) { next(error); }
  });
  return router;
}
