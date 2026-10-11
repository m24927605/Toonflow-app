import { z } from "zod";
import { chainMethods, executeRemoteFfmpeg, queryMethods, runMethods } from "@toonflow/ffmpeg/remote";
import type { ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.strictObject({});
const probeSchema = z.strictObject({
  path: z.string().min(1).describe("Workspace media file, as a relative path or an absolute path inside the workspace"),
  options: z.array(z.string()).optional().describe("Native ffprobe options, passed through as an argument array"),
});
const processSchema = z.strictObject({
  options: z.strictObject({
    source: z.string().optional(),
    cwd: z.string().optional(),
    niceness: z.number().optional(),
    priority: z.number().optional(),
    stdoutLines: z.number().optional(),
    timeout: z.number().optional(),
  }).optional().describe("Native fluent constructor options; no fixed timeout is set"),
  steps: z.array(z.strictObject({
    method: z.enum(chainMethods),
    args: z.array(z.json()),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional().describe("Argument positions that need undefined; other arguments keep their original values"),
  })).default([]).describe("Configured in fluent-ffmpeg order; methods and their aliases follow the host; options, filters and file sequences are passed through as-is"),
  operation: z.strictObject({
    method: z.enum([...runMethods, ...queryMethods]),
    args: z.array(z.json()),
    undefinedArgs: z.array(z.number().int().nonnegative()).optional(),
  }).default({ method: "run", args: [] }).describe("The method executed last, run by default; can also be save, screenshots, concat, or queries for encoders, formats, filters and so on"),
});

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools(context) {
    async function execute(request: z.infer<typeof processSchema>, signal?: AbortSignal) {
      const ffmpeg = await context.ffmpeg(signal);
      let details: unknown;
      let error: Error | undefined;
      let filenames: unknown;
      // ACT: Reuse the node's existing JSON call bridge;
      // the tool layer does not rewrite arguments, output locations or native execution rules.
      await executeRemoteFfmpeg(ffmpeg, {
        directory: context.cwd,
        requestId: crypto.randomUUID(),
        options: request.options ?? {},
        calls: request.steps,
        operation: request.operation,
      }, event => {
        if (event.event === "error") {
          const failure = event.args[0] as { message?: string };
          error = Object.assign(new Error(failure.message ?? "FFmpeg execution failed"), failure);
        } else if (event.event === "result") details = event.args[0];
        else if (event.event === "filenames") filenames = event.args[0];
        else if (event.event === "end") details = { stdout: event.args[0], stderr: event.args[1], ...(filenames ? { filenames } : {}) };
      }, signal ?? new AbortController().signal);
      signal?.throwIfAborted();
      if (error) throw error;
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }

    return [{
      name: "ffprobe",
      label: "Query media information",
      description: "Use the local FFprobe to read workspace media format, duration, dimensions, frame rate, audio tracks and other information; supports native probe options.",
      parameters: z.toJSONSchema(probeSchema, { io: "input", target: "draft-07" }),
      execute(_id, params, signal) {
        const { path, options } = probeSchema.parse(params);
        return execute({ steps: [{ method: "input", args: [path] }], operation: { method: "ffprobe", args: options ? [options] : [] } }, signal);
      },
    }, {
      name: "ffmpeg",
      label: "Process media",
      description: "Process workspace media through the host fluent-ffmpeg. steps pass chained methods and args through as-is, supporting all host configuration methods and aliases, raw inputOptions/outputOptions, complex filters, multiple inputs, multiple outputs, file sequences and segmenting. operation defaults to run and also supports save, screenshots, concat and capability queries. Outputs are not renamed automatically and execution time is not limited; the output directory must already exist, and file overwriting follows native rules.",
      promptSnippet: "Use ffmpeg to process local media and ffprobe to query media information; choose the output location as the user requests.",
      promptGuidelines: [
        "Frame capture example: {\"steps\":[{\"method\":\"input\",\"args\":[\"assets/input.mp4\"]},{\"method\":\"seekInput\",\"args\":[1]},{\"method\":\"frames\",\"args\":[1]},{\"method\":\"output\",\"args\":[\"assets/frame.png\"]}]}.",
        "Pass inputOptions/outputOptions using native fluent syntax, without extra splitting on spaces. For metadata containing spaces use args:[\"-metadata\",\"title=a b\"], and do not nest another array. First query actual capabilities with operation={\"method\":\"availableEncoders\",\"args\":[]} and similar; do not guess the local encoders.",
        "Use a new file name unless the user asks to overwrite; all explicit paths and files referenced in arguments, filters and media lists should be inside the current workspace.",
      ],
      parameters: z.toJSONSchema(processSchema, { io: "input", target: "draft-07" }),
      executionMode: "sequential",
      execute(_id, params, signal) {
        return execute(processSchema.parse(params), signal);
      },
    }];
  },
};

export default plugin;
