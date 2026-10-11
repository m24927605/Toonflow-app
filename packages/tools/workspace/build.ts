import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "workspace",
  displayName: "Workspace files",
  description: "Reads, lists and edits files in the current workspace, and downloads remote images into it.",
  prompt: `Paths are resolved relative to the current workspace. File modifications must not go outside the workspace; the global skills directory only allows reading skills and their bundled materials.
Read the relevant content before modifying an existing file to avoid overwriting the user's changes.
When an available skill matches the task, read the SKILL.md in the skill directory first, then read the local materials it references as needed; do not load all skills at once, and do not guess a skill's content from its name alone.`,
  author: "Toonflow",
  configRules: [
    { type: "switch", field: "readOnly", title: "Read-only mode", value: false, info: "When enabled, only reading files and listing directories are allowed." },
  ],
}, import.meta.url);
