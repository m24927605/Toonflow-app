import { z } from "zod";
import type { ToolDefinition, ToolPlugin } from "@toonflow/tools-scaffold/runtime";

const configSchema = z.object({ readOnly: z.boolean().default(false) }).strict();
const downloadImageSchema = z.object({ url: z.string().trim().min(1).max(8192).describe("Direct link to a public HTTP(S) image") }).strict();

const plugin: ToolPlugin = {
  validateConfig: config => configSchema.parse(config),
  createTools({ cwd, config, files, sdk }) {
    const { readOnly } = configSchema.parse(config);
    const tools: ToolDefinition[] = [
      sdk.defineTool(sdk.createReadToolDefinition(cwd, { operations: {
        readFile: path => files.readFile(path, true),
        access: path => files.access(path, true),
        detectImageMimeType: path => files.detectImageMimeType(path, true),
      } })),
      sdk.defineTool(sdk.createLsToolDefinition(cwd, { operations: {
        exists: async path => {
          try { await files.access(path, true); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
        },
        stat: path => files.stat(path, true),
        readdir: path => files.readdir(path, true),
      } })),
    ];
    if (!readOnly) {
      tools.splice(1, 0,
        sdk.defineTool(sdk.createWriteToolDefinition(cwd, { operations: {
          writeFile: files.writeFile,
          mkdir: path => files.mkdir(path, true),
        } })),
        sdk.defineTool(sdk.createEditToolDefinition(cwd, { operations: { readFile: files.readFile, access: files.access, writeFile: files.writeFile } })),
      );
      tools.push({
        name: "downloadImage",
        label: "Download image",
        description: "Download a public HTTP(S) image and save it to the current workspace, returning the workspace-relative path and MIME type. Supports PNG, JPEG, WebP, GIF, AVIF and BMP, up to 20 MB per image; images that require login, SVG, and local or private network addresses are not supported. The host decides the output path; no directory needs to be specified.",
        promptSnippet: "Download a remote image to the workspace and return a relative path usable for local preview and as a reference asset.",
        promptGuidelines: ["Use downloadImage to save remote images; do not download them with web_fetch, write or FFmpeg. On success, display a Markdown image using the returned workspace-relative path, for example ![Image](<assets/chatImages/filename.jpg>)."],
        parameters: z.toJSONSchema(downloadImageSchema, { io: "input", target: "draft-07" }),
        executionMode: "sequential",
        async execute(toolCallId, params, signal) {
          signal?.throwIfAborted();
          const { url } = downloadImageSchema.parse(params);
          const result = await files.importImage(url);
          signal?.throwIfAborted();
          return {
            content: [{ type: "text", text: `Image saved to the workspace: ${result.path}
MIME type: ${result.mimeType}
![Downloaded image](<${result.path}>)` }],
            details: result,
          };
        },
      });
    }
    return tools.map(tool => ({
      ...tool,
      promptGuidelines: [
        ...(tool.promptGuidelines ?? []),
        ...(readOnly ? ["The current file tools only support reading and cannot be used to write or edit files; the capabilities of other tools are as described in their own descriptions."] : []),
      ],
    }));
  },
};

export default plugin;
