import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import { teamNameSchema } from "@toonflow/teams-scaffold/runtime";
import { addUsage, emptyUsage, type SubAgentModel, type SubAgentResult } from "@/agent/runtime/subAgent";
import { createTeamRunner } from "@/agent/teams";
import { runRemoteTeam } from "@/agent/teams/remote";
import { listTeams, getRemoteTeam } from "@/utils/teams";

const parameters = z.strictObject({
  tasks: z.array(z.strictObject({
    name: z.string().trim().min(1).max(80).describe("The name of this task"),
    task: z.string().trim().min(1).max(24000).describe("Complete task, necessary context, relative paths, granted permissions, and expected deliverables; does not inherit the main conversation history"),
    team: teamNameSchema.optional().describe("The installed team or remote A2A connection name; if omitted, a temporary sub-Agent will be created"),
    taskId: z.string().min(1).max(512).optional().describe("Pass this back unchanged when resuming a remote A2A task awaiting additional input"),
    contextId: z.string().min(1).max(512).optional().describe("Returned unchanged when continuing the remote A2A session"),
  })).min(1),
});

export async function createSubAgentTool({ cwd, tools, canvas, runTask, ...modelOptions }: SubAgentModel & {
  cwd: string; tools: ToolDefinition[]; canvas?: CanvasContext;
  runTask: (name: string, task: string, signal?: AbortSignal, onProgress?: (text: string) => void) => Promise<{ result: SubAgentResult; usage: ReturnType<typeof emptyUsage> }>;
}): Promise<ToolDefinition> {
  if (tools.some(tool => tool.name === "subAgent")) throw new Error("The tool name subAgent is already occupied by the built-in subtask tool");
  const teams = (await listTeams()).filter(team => team.enabled && !team.loadError);
  const subAgentTool: ToolDefinition = {
    name: "subAgent", label: "Subtasks and Teams",
    description: `Run delegated independent tasks in parallel. Omit team to create a sub-agent that can continue the conversation and inherits the host tools, including asking questions, further delegation and report; specify team to call an installed team or an external A2A agent. Host tools: ${[...tools.map(tool => tool.name), "subAgent"].join(", ")}. Team directory: ${JSON.stringify(teams.map(({ name, description, kind }) => ({ name, description, kind })))}. Local teams divide work according to their manifest. There is no fixed limit on the number of tasks, concurrency, execution rounds or total duration; the user can stop them.`,
    promptSnippet: "Use subAgent as needed to delegate independent work, or specify an installed team to call a dedicated team.",
    promptGuidelines: [
      "Complete simple tasks directly; delegate only mutually independent work, and provide the necessary context and actual authorization. Parallel tasks must not modify the same file or canvas; handle dependent tasks in separate rounds.",
      "Delegation does not expand permissions or authorization to consume compute. Remote teams receive the task text; send only content that is needed for the task and approved for sharing. They cannot access local tools or files that were not sent.",
      "Verify the result and status. inputRequired means it is waiting for more input; confirm with the user, then continue that remote team with the original taskId/contextId. Errors, cancellations and reached limits do not mean completion; do not automatically retry tasks that may already have produced side effects.",
    ],
    parameters: z.toJSONSchema(parameters, { io: "input", target: "draft-07" }),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
      signal?.throwIfAborted();
      const { tasks } = parameters.parse(params);
      const results: SubAgentResult[] = tasks.map(task => ({ name: task.name, status: "running", result: "Ready to execute" }));
      const usage = emptyUsage();
      const content = () => [{ type: "text" as const, text: JSON.stringify({ tasks: results }) }];
      const update = () => { if (!signal?.aborted) onUpdate?.({ content: content(), details: {} }); };
      update();
      await Promise.all(tasks.map(async (task, index) => {
        const onProgress = (text: string) => { results[index]!.result = text; update(); };
        try {
          const remote = task.team && getRemoteTeam(task.team);
          if ((task.taskId || task.contextId) && !remote) throw new Error("Only the remote A2A team supports taskId/contextId");
          const output = remote
            ? await runRemoteTeam({ ...task, name: task.team!, signal, onProgress })
            : task.team
              ? await (await createTeamRunner({ ...modelOptions, cwd, tools: inheritedTools, canvas, name: task.team })).run(task.task, signal, onProgress)
              : await runTask(task.name, task.task, signal, onProgress);
          results[index] = { ...output.result, name: task.name };
          addUsage(usage, output.usage);
        } catch (error) {
          results[index] = { name: task.name, status: signal?.aborted ? "cancelled" : "error", result: error instanceof Error ? error.message : String(error) };
        }
        update();
      }));
      return { content: content(), details: {}, usage };
    },
  };
  const inheritedTools = [...tools, subAgentTool];
  return subAgentTool;
}
