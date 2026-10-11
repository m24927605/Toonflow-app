import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { reportToParent } from "@/agent/runtime/sessions";
import type { AgentEvent } from "@/agent/runtime/types";

export function createReportTool(cwd: string, parentFile: string, file: string, name: string, send: (event: AgentEvent) => void): ToolDefinition {
  const parameters = z.strictObject({ content: z.string().trim().min(1).max(16000).describe("Conclusion, progress or issues requiring coordination reported to the parent Agent") });
  return {
    name: "report", label: "Report to parent Agent",
    description: "Submits the important progress or final conclusion of the current subtask to the parent Agent. Reports into the context of the parent Agent; does not replace the current direct conversation with the user, nor automatically launch an idle parent agent.",
    promptGuidelines: ["When you finish the delegated task or find an issue that needs coordination by the parent agent, use report to submit the actual conclusions, changes, verification status and unfinished items."],
    parameters: z.toJSONSchema(parameters), executionMode: "sequential",
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const { content } = parameters.parse(params);
      const id = await reportToParent(cwd, parentFile, file, name, content);
      send({ type: "report", id, parentFile, file, name, content });
      return { content: [{ type: "text", text: "has been reported to the parent Agent" }], details: { id } };
    },
  };
}
