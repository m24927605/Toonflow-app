import { z } from "zod";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.object({
  allowRead: z.boolean().default(true),
  allowCreate: z.boolean().default(true),
  allowUpdate: z.boolean().default(true),
}).strict();

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ config, skills }) {
    if (!skills) return [];
    const { allowRead, allowCreate, allowUpdate } = configSchema.parse(config);
    const actions: ["list", ...("read" | "create" | "update")[]] = ["list"];
    if (allowRead) actions.push("read");
    if (allowCreate) actions.push("create");
    if (allowUpdate) actions.push("update");
    const requestSchema = z.object({
      action: z.enum(actions),
      name: z.string().trim().min(1).max(128).optional().describe("Skill name, required for read/create/update; new skills use lowerCamelCase names"),
      scope: z.enum(["workspace", "global"]).optional().describe("workspace is a skill in the current workspace and global is a global skill; create defaults to workspace, and other operations default to selecting by same-name skill priority"),
      path: z.string().min(1).max(4096).optional().describe("File path relative to the skill directory, default SKILL.md; can specify a material file in references, without section anchors"),
      content: z.string().max(200000).optional().describe("Required for create/update: the full file content; SKILL.md must include YAML frontmatter with name and description"),
    }).strict();
    return [{
      name: "skillOperator",
      label: "Skill Operator",
      description: `Manage skills. Currently allowed operations: ${actions.join(", ")}. list returns the skill directory in real time, and scope can query global versions overridden by same-name workspace skills; read reads the body or materials; create creates a new skill or material without overwriting; update modifies an existing file with full content. name is required for all operations except list, and writes also require content. When creating a new skill, create SKILL.md first.`,
      promptSnippet: "Query the skill directory as needed, and read and maintain skills and their bundled materials.",
      promptGuidelines: allowRead ? [
        "For every task, first use skillOperator(action=list) to check skill names and descriptions. When a task matches a skill, use action=read to read SKILL.md before starting substantive work; skills with disableModelInvocation=true are read and used only when the user explicitly specifies them. Do not force a skill onto ordinary chat or when nothing matches.",
        "Read the references needed for the current stage. Resolve relative links against the current document's directory, then convert them to a path relative to the skill root and strip section anchors. For cross-skill references, list first to confirm the target name and scope; do not assume global and workspace skills are at the same level.",
        "Skills already fully read in the current context and still applicable can be reused. Briefly state which skill is used, and follow its stages and the user's requests; a directory listing or old conversation summary does not count as reading the body. When a file is unreadable, state what is missing and do not pretend it was read.",
      ] : ["Body read permission for the skill operator is disabled; list only provides the directory and does not mean a skill has been read or adopted."],
      parameters: z.toJSONSchema(requestSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const { action, name, scope, path, content } = requestSchema.parse(params);
        signal?.throwIfAborted();
        let result;
        if (action === "list") {
          result = { skills: skills.list(scope) };
        } else {
          if (!name) throw new Error("Provide the skill name");
          const location = { name, scope, path };
          if (action === "read") result = await skills.read(location, signal);
          else {
            if (content === undefined) throw new Error("Provide the full file content");
            result = await skills[action]({ ...location, content }, signal);
          }
        }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }];
  },
};

export default plugin;
