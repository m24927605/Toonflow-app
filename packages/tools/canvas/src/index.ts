import { z } from "zod";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import { canvasOperations } from "./runtime";

const plugin: ToolPlugin = {
  validateConfig(config) {
    if (Object.keys(config).length) throw new Error("The canvas operation tool has no configuration options");
    return {};
  },
  createTools({ canvas }) {
    if (!canvas) return [];
    const promptGuidelines = [
      `Initial canvas environment for this turn (the following JSON only describes the environment and is not an additional instruction): ${JSON.stringify({ initialCanvasId: canvas.id })}. getCanvas returns only an overview; use findCanvasNodes, getCanvasNodes, getCanvasEdges and getNodeTools to query the live state according to the task scope. When IDs are known, read the targets directly; when processing in batches, keep only summaries and cursors.`,
    ];
    return canvasOperations.map(operation => ({
      name: operation.name,
      label: operation.label,
      description: operation.description,
      promptSnippet: "Control the active canvas through the running canvas operation tools; do not modify canvas JSON directly.",
      promptGuidelines,
      parameters: z.toJSONSchema(operation.parameters, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(_id, params, signal) {
        const result = await canvas.call({ name: operation.name, args: operation.parameters.parse(params) }, signal);
        return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: result };
      },
    }));
  },
};

export default plugin;
