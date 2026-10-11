import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "assetOperator",
  displayName: "Global Asset Manager",
  description: "Queries, reads and maintains the global asset library, imports assets into the workspace and archives generated results.",
  prompt: `The global asset library is queried and managed through assetOperator and is separate from the current workspace's assets folder.
Query and read the relevant assets first, then maintain them as the user requests; carry forward the authorization already given in the current session, and ask only when a deletion or overwrite is outside the authorized scope.
Use sourcePath to add workspace generation results to the library; before using a global asset on the canvas or as a generation reference, import it into the current workspace first and use the real path returned.`,
  author: "Toonflow",
  configRules: [
    { type: "switch", field: "readOnly", title: "Read-only mode", value: false, info: "When enabled, modifying the global asset library is forbidden; querying, reading and copying assets into the current workspace are still allowed." },
  ],
}, import.meta.url);
