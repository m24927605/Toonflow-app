import { z } from "zod";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const optionsSchema = z.array(z.string().trim().min(1).max(300)).max(20)
  .refine(options => new Set(options).size === options.length, "Options cannot be repeated");

const fieldSchema = z.object({
  field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)
    .refine(field => !["constructor", "prototype", "__proto__"].includes(field), "Field name unavailable")
    .describe("Unique lowerCamelCase field name, for example duckRef; English letters and digits only, no underscores or hyphens"),
  title: z.string().trim().min(1).max(200),
  type: z.enum(["input", "textarea", "radio", "checkbox", "select", "inputNumber", "switch"]),
  required: z.boolean().optional(),
  options: optionsSchema.optional().describe("radio, checkbox and select types must provide non-empty options"),
  placeholder: z.string().trim().max(300).optional(),
}).refine(field => !["radio", "checkbox", "select"].includes(field.type) || !!field.options?.length,
  "Choice fields must provide options");

const questionSchema = z.object({
  title: z.string().trim().min(1).max(100).describe("Question card title that briefly summarizes what needs to be confirmed"),
  question: z.string().trim().min(1).max(4000).describe("Required: the question, or a description of the whole set of questions; must also be provided when using fields"),
  options: optionsSchema.max(8).optional(),
  fields: z.array(fieldSchema).max(12)
    .refine(fields => new Set(fields.map(field => field.field)).size === fields.length, "Field names must be unique").optional()
    .describe("Multiple questions, one per item; when non-empty fields are provided, top-level options cannot also be provided"),
}).refine(request => !request.fields?.length || request.options === undefined, "A dynamic form cannot also provide top-level options");

const plugin: ToolPlugin = {
  validateConfig(config) {
    if (Object.keys(config).length) throw new Error("The question tool has no configuration options");
    return {};
  },
  createTools({ question }) {
    if (!question) return [];
    return [{
      name: "askUser",
      label: "Ask User",
      description: "Call when the user needs to provide more information or make a choice. Use options for a single multiple-choice question and fields for multiple questions. The result contains answer, plus values for multiple questions; returns skipped: true when the user skips the whole set.",
      promptSnippet: "Ask one or more questions at once; the user can answer or skip, and skipping does not mean the stage is confirmed.",
      parameters: z.toJSONSchema(questionSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      async execute(id, params, signal) {
        const result = await question.ask(id, questionSchema.parse(params), signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }];
  },
};

export default plugin;
