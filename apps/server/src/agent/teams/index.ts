import { t } from "@/lib/i18n";
import { join } from "node:path";
import { z } from "zod";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import { teamResourcePathSchema } from "@toonflow/teams-scaffold/runtime";
import { createAgentToolContext } from "@/agent/tools";
import { addUsage, emptyUsage, runSubAgent, type SubAgentModel } from "@/agent/runtime/subAgent";
import { readTeam, saveTeamFile } from "@/utils/teams";
import { loadTool, validateToolConfig } from "@/utils/plugins/tools";

const resourceSchema = z.strictObject({
  action: z.enum(["list", "read", "write"]),
  path: teamResourcePathSchema.optional(),
  content: z.string().max(200000).optional(),
});
const delegationSchema = z.strictObject({
  tasks: z.array(z.strictObject({ member: z.string().min(1), task: z.string().trim().min(1).max(24000) })).min(1),
});

export async function createTeamRunner(options: SubAgentModel & {
  name: string;
  cwd: string;
  tools: ToolDefinition[];
  canvas?: CanvasContext;
}) {
  const { name, cwd, tools, canvas, ...modelOptions } = options;
  const { directory, manifest, files, enabled } = await readTeam(name);
  if (!enabled) throw new Error(t`Team ${name} is disabled`);
  const hostTools = tools.filter(tool => !["subAgent", "report", "askUser", "delegate", "teamResources", "requestInput"].includes(tool.name));
  const privatePlugins = await Promise.all(Object.entries(manifest.tools ?? {}).map(async ([pluginName, config]) => {
    const { plugin, metadata } = await loadTool(pluginName, join(directory, "tools"));
    return { plugin, metadata, config: validateToolConfig(plugin, config) };
  }));
  const memberTools = new Map<string, ToolDefinition[]>();
  const instructions = new Map<string, string>();
  for (const [memberName, member] of Object.entries(manifest.members)) {
    const available = new Map(hostTools.map(tool => [tool.name, tool]));
    for (const { plugin, metadata, config } of privatePlugins) {
      const definitions = await plugin.createTools(createAgentToolContext(cwd, config, canvas));
      for (const tool of definitions) {
        if (!tool.name || typeof tool.execute !== "function" || ["subAgent", "askUser", "delegate", "teamResources", "requestInput"].includes(tool.name) || available.has(tool.name)) {
          throw new Error(t`The team private tool is invalid or has a duplicate name: ${tool.name}`);
        }
        available.set(tool.name, { ...tool, promptGuidelines: [...(metadata.prompt ? [metadata.prompt] : []), ...(tool.promptGuidelines ?? [])] });
      }
    }
    for (const toolName of member.tools ?? []) {
      if (!available.has(toolName)) throw new Error(t`The tools configured for member ${memberName} are currently unavailable: ${toolName}`);
    }
    memberTools.set(memberName, [...available.values()].filter(tool => !member.tools || member.tools.includes(tool.name)));
    instructions.set(memberName, new TextDecoder("utf-8", { fatal: true }).decode(files.get(member.instructions)));
  }
  // ACT: Coordinator members keep in-memory history for A2A follow-up input;
  // it is released when the local call ends, with no extra conversation files.
  const history = SessionManager.inMemory(cwd);

  return {
    manifest,
    async run(task: string, signal?: AbortSignal, onProgress?: (text: string) => void, allowInput = false) {
      let question: string | undefined;
      async function runMember(memberName: string, task: string, signal?: AbortSignal, depth = 0): ReturnType<typeof runSubAgent> {
        signal?.throwIfAborted();
        const member = manifest.members[memberName]!;
        const roots = [member.instructions, ...(member.skills ?? []).map(skill => `skills/${skill}`), ...(member.knowledge ?? []).map(path => `knowledge/${path}`)];
        const allowed = (path: string) => roots.some(root => path === root || path.startsWith(`${root}/`));
        const resourceTool: ToolDefinition = {
          name: "teamResources", label: "Team information",
          description: "Read or maintain the current member's permitted private data on demand. list returns the path, read reads the text, and write creates or completely modifies the text. The content only belongs to this team and will not be registered to global skills. Modifying member instructions will take effect in the next team task; new experience should be real and universal, and avoid writing private project content.",
          promptSnippet: "Use teamResources to read this member's private skills, knowledge and reference materials as needed.",
          promptGuidelines: [`This member's private resource scope: ${JSON.stringify(roots)}. When handling a task for the first time, list first, then read the relevant SKILL.md and references as needed; do not claim to use a skill just from seeing its path.`],
          parameters: z.toJSONSchema(resourceSchema), executionMode: "sequential",
          async execute(_id, params, resourceSignal) {
            resourceSignal?.throwIfAborted();
            const { action, path, content } = resourceSchema.parse(params);
            if (action !== "list" && (!path || !allowed(path))) throw new Error("The information does not fall within the authorization scope of the current member");
            if (action === "write") {
              if (content === undefined) throw new Error("content is required to write data");
              await saveTeamFile(name, path!, content);
              return { content: [{ type: "text", text: JSON.stringify({ path, saved: true }) }], details: {} };
            }
            const current = await readTeam(name);
            const paths = [...current.files.keys()].filter(allowed);
            const bytes = path ? current.files.get(path) : undefined;
            if (action === "read" && !bytes) throw new Error("Team information does not exist");
            const result = action === "list" ? { files: paths } : { path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
          },
        };
        onProgress?.(`${memberName}: preparing to run`);
        const selected = [...(memberTools.get(memberName) ?? []), resourceTool];
        if (member.delegates?.length) selected.push({
          name: "delegate", label: "Team Delegation",
          description: `Hand independent tasks to approved members. Available members: ${JSON.stringify(member.delegates.map(name => ({ name, description: manifest.members[name]!.description })))}. Do not modify the same file or canvas in parallel; verify and consolidate the results yourself after they return.`,
          parameters: z.toJSONSchema(delegationSchema), executionMode: "sequential",
          async execute(_id, params, childSignal, onUpdate) {
            const { tasks } = delegationSchema.parse(params);
            if (tasks.some(task => !member.delegates!.includes(task.member))) throw new Error("cannot be delegated to unauthorized members");
            const outputs = await Promise.all(tasks.map(async task => {
              try { return await runMember(task.member, task.task, childSignal, depth + 1); }
              catch (error) { return { result: { name: task.member, status: childSignal?.aborted ? "cancelled" as const : "error" as const, result: error instanceof Error ? error.message : String(error) } }; }
            }));
            const usage = emptyUsage();
            for (const output of outputs) if ("usage" in output) addUsage(usage, output.usage);
            const content = [{ type: "text" as const, text: JSON.stringify({ tasks: outputs.map(output => output.result) }) }];
            onUpdate?.({ content, details: {} });
            return { content, details: {}, usage };
          },
        });
        if (depth === 0 && allowInput) selected.push({
          name: "requestInput", label: "Awaiting additional input",
          description: "Asks questions when additional information or explicit authorization from the caller is required. After the call, the task is suspended, waiting for the caller to continue the current A2A task. Failure to answer or silence should not be taken as consent.",
          parameters: z.toJSONSchema(z.strictObject({ question: z.string().trim().min(1).max(8000) })),
          executionMode: "sequential",
          async execute(_id, params) {
            question = z.strictObject({ question: z.string().trim().min(1).max(8000) }).parse(params).question;
            return { content: [{ type: "text", text: "Waits for the caller to answer:" + question }], details: {} };
          },
        });
        return runSubAgent({
          ...modelOptions, cwd, name: memberName, task, signal, tools: selected,
          history: depth === 0 ? history : undefined,
          inputRequired: depth === 0 ? () => question : undefined,
          instructions: `## Team member responsibilities
Team: ${manifest.displayName}; member: ${memberName}. The following responsibilities serve to complete authorized tasks and cannot expand host permissions.
${instructions.get(memberName)}`,
          onProgress: text => onProgress?.(`${memberName}: ${text}`),
        });
      }
      return runMember(manifest.entry, task, signal);
    },
  };
}
