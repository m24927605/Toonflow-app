import { t } from "@/lib/i18n";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { realpath, stat, mkdir, readdir, lstat, rm, rmdir, readFile } from "@toonflow/file";
import { z } from "zod";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import type { McpTool } from "@toonflow/mcp";
import { createAgentTools } from "@/agent/tools";
import { run as runAgent } from "@/agent";
import conf from "@/utils/conf";
import { callControl, getConnection, listConnections } from "@/utils/mcp/control";
import { appOperations, runAppOperation } from "@/utils/mcp/operations";
import { listTools } from "@/utils/plugins/tools";
import { isWithin, lockWorkspaceFiles, protectWorkspaceRoot, renameWorkspaceFile, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

const targetSchema = z.strictObject({ connectionId: z.uuid().optional(), directory: z.string().min(1).max(4096).optional(), canvasId: z.string().min(1).max(256).optional() });
const requestSchema = z.strictObject({ target: targetSchema.optional(), args: z.record(z.string(), z.unknown()) });
let authorizationController = new AbortController();
for (const key of ["settings.mcp.enabled", "settings.mcp.token"] as const) conf.onDidChange(key, () => {
  authorizationController.abort();
  authorizationController = new AbortController();
});

async function resolveDirectory(directory?: string) {
  if (!directory || !isAbsolute(directory)) throw new Error("Please specify the absolute working directory in target.directory, or open the project first");
  const path = await realpath(directory);
  if (!(await stat(path)).isDirectory()) throw new Error("The working directory is not a folder");
  const local = ["win32", "darwin"].includes(process.platform) && process.env.NODE_ENV === "dev";
  if (!local) {
    const root = await realpath(resolve(dirname(conf.path), "workspaces"));
    if (!isWithin(root, path)) throw new Error("Server deployment can only use workspaces within data/workspaces");
  }
  return path;
}

async function resolveTarget(target: z.infer<typeof targetSchema> = {}, requireDirectory = true) {
  const requestedDirectory = target.directory ? await resolveDirectory(target.directory) : undefined;
  const connection = getConnection(target.connectionId, requestedDirectory);
  if (target.connectionId && requestedDirectory && connection?.state.directory !== requestedDirectory) throw new Error("The workspace of the target page has been switched, please obtain getAppState again");
  if (target.canvasId && connection?.state.canvasId !== target.canvasId) throw new Error("The target canvas has been switched, please obtain getAppState again");
  const directory = requireDirectory ? requestedDirectory ?? await resolveDirectory(connection?.state.directory ?? undefined) : undefined;
  return { connection, directory };
}

function wrapTool(name: string, description: string, schema: object, execute: (args: Record<string, unknown>, target: z.infer<typeof targetSchema>, signal: AbortSignal) => Promise<unknown>): McpTool {
  // Root references in the plugin JSON Schema still point to the original parameter object after wrapping.
  const argsSchema = JSON.parse(JSON.stringify(schema).replace(/"\$ref":"#(?=\/|")/g, '"$ref":"#/properties/args'));
  return {
    name, description,
    inputSchema: { type: "object", properties: { target: z.toJSONSchema(targetSchema), args: argsSchema }, required: ["args"], additionalProperties: false },
    async execute(input, signal) {
      const { args, target = {} } = requestSchema.parse(input);
      return execute(args, target, signal);
    },
  };
}

const uiSchemas = {
  openProject: z.strictObject({ directory: z.string().min(1).max(4096) }),
  switchPanel: z.strictObject({ panel: z.enum(["canvas", "document"]) }),
  getDocument: z.strictObject({}),
  openDocument: z.strictObject({ path: z.string().max(4096).optional(), canvasPath: z.string().max(4096).optional(), nodeId: z.string().max(256).optional(), handleId: z.string().max(256).optional() }),
  writeDocument: z.strictObject({ text: z.string().max(10_000_000), expectedText: z.string().max(10_000_000) }),
  getSettings: z.strictObject({}),
  updateSettings: z.strictObject({ patch: z.record(z.string(), z.json()).refine(patch => !["mcp", "stores"].some(key => Object.hasOwn(patch, key)), "Cannot modify connection credentials or project list via MCP") }),
};
const uiDescriptions: Record<keyof typeof uiSchemas, string> = {
  openProject: "Open the existing working directory on the target Toonflow page and wait for the workspace to be ready; obtain the connectionId of getAppState before operating.",
  switchPanel: "Switch to the canvas or document panel of the workspace and save the current edits first.",
  getDocument: "Read the current document content and selection status. writeDocument must carry the text read this time as expectedText.",
  openDocument: "Open the document file (path) in the workspace, or the text node (canvasPath, nodeId, optional handleId) in the canvas.",
  writeDocument: "Save the current document through the document editor; expectedText must match the current content to prevent overwriting new user input.",
  getSettings: "Read the page's current settings with access credentials masked.",
  updateSettings: "Merge and save the specified top-level settings and update the page. Do not modify mcp credentials or the project list in stores. Read nested settings before merging them.",
};

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api.?key|access.?token|refresh.?token|password|secret|authorization)$|^token$/i.test(key) ? (item ? "[REDACTED]" : "") : redactSecrets(item)]));
}

async function assertFileNotOpen(directory: string, path: string) {
  const target = (await resolveWorkspacePath(directory, relative(directory, resolve(directory, path)), true)).path;
  for (const { state } of listConnections()) {
    if (state.directory !== directory) continue;
    const document = state.document as { selection?: { filePath?: string; canvasPath?: string } } | undefined;
    const openPaths = [state.canvasId, document?.selection?.filePath, document?.selection?.canvasPath];
    for (const file of openPaths) {
      if (!file) continue;
      const opened = (await resolveWorkspacePath(directory, relative(directory, resolve(directory, file)), true)).path;
      if (isWithin(target, opened)) throw new Error("The file is open in Toonflow. Modify it using the canvas or document tools, or close it before performing file operations.");
    }
  }
}

export async function getMcpTools(): Promise<McpTool[]> {
  const authorizationSignal = authorizationController.signal;
  let pluginError: string | undefined;
  const tools: McpTool[] = [{
    name: "getAppState", description: "Lists the connected Toonflow page with its connectionId, working directory, canvas, project list, and node capabilities. When there are multiple pages, target.connectionId must be used to clarify the operation object; when there is no page connection, only the server-side tool with explicit target.directory is available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const workspaceRoot = resolve(dirname(conf.path), "workspaces");
      await mkdir(workspaceRoot, { recursive: true });
      return { connections: listConnections(), workspaceRoot, ...(pluginError ? { pluginError } : {}) };
    },
  }];
  for (const [name, schema] of Object.entries(uiSchemas)) {
    tools.push(wrapTool(name, uiDescriptions[name as keyof typeof uiSchemas], z.toJSONSchema(schema), async (input, target, signal) => {
      const args = schema.parse(input);
      const { connection, directory } = await resolveTarget(target, !["openProject", "getSettings", "updateSettings"].includes(name));
      if (!connection) throw new Error("Open the Toonflow web page first");
      if (name === "openProject") await resolveDirectory((args as { directory: string }).directory);
      const result = await callControl(connection.id, name, args, signal, directory);
      return name === "getSettings" || name === "updateSettings" ? redactSecrets(result) : result;
    }));
  }
  const canvasStub: CanvasContext = { id: "mcp", tools: [], async call() { throw new Error("The canvas has not been bound yet"); } };
  // ACT: Keep the app management tools when a plugin is broken so errors can be read and the plugin fixed.
  const definitions = await createAgentTools(dirname(conf.path), canvasStub).catch(error => {
    pluginError = error instanceof Error ? error.message : String(error);
    return [];
  });
  for (const definition of definitions) {
    if (tools.some(tool => tool.name === definition.name)) throw new Error(t`Duplicate MCP tool name: ${definition.name}`);
    tools.push(wrapTool(definition.name, [definition.description, ...(definition.promptGuidelines ?? [])].join("\n"), definition.parameters, async (args, target, signal) => {
      const { connection, directory } = await resolveTarget(target);
      if (["write", "edit"].includes(definition.name) && typeof args.path === "string") await assertFileNotOpen(directory!, args.path);
      const canvas: CanvasContext | undefined = connection ? {
        id: connection.state.canvasId ?? "mcp", tools: connection.state.tools,
        call: (request, callSignal) => callControl(connection.id, request.name, request.args, callSignal ?? signal, directory),
      } : undefined;
      const current = (await createAgentTools(directory!, canvas)).find(tool => tool.name === definition.name);
      if (!current) throw new Error("The tool is disabled, or the required Toonflow page is not connected, please re-read the tool list");
      // ACT: Existing plugins rely on host capabilities injected by createTools; MCP
      // has no Pi conversation, so session capabilities throw an explicit error.
      const context = new Proxy({ cwd: directory, mode: "rpc", hasUI: false, model: undefined, signal }, {
        get(value, key) { if (Reflect.has(value, key)) return Reflect.get(value, key); throw new Error(t`MCP does not provide built-in Agent session capabilities: ${String(key)}`); },
      }) as unknown as ExtensionToolContext;
      return current.execute(crypto.randomUUID(), args, signal, undefined, context);
    }));
  }
  const fileSchema = z.strictObject({
    action: z.enum(["list", "mkdir", "rename", "remove", "readBinary", "writeBinary"]), path: z.string().max(4096).default(""),
    target: z.string().max(4096).optional(), recursive: z.boolean().default(false),
    base64: z.string().max(28_000_000).base64().optional(), exclusive: z.boolean().default(true),
  });
  tools.push(wrapTool("workspaceFiles", "List workspace files, create directories, rename or delete files. readBinary/writeBinary transfers media up to 20MB using base64; writes do not overwrite existing files by default. Reuse the enabled file tools for text reads and writes. Open canvases and documents must be edited through their dedicated tools.", z.toJSONSchema(fileSchema, { io: "input" }), async (input, target, signal) => {
    const args = fileSchema.parse(input);
    const workspaceTool = (await listTools()).find(tool => tool.name === "workspace");
    if (!workspaceTool?.enabled || workspaceTool.loadError) throw new Error("The workspace file tool is not enabled or failed to load");
    if (!["list", "readBinary"].includes(args.action) && "readOnly" in workspaceTool.config && workspaceTool.config.readOnly === true) throw new Error("The current workspace file tool is in read-only mode");
    const { directory } = await resolveTarget(target);
    const source = await resolveWorkspacePath(directory!, args.path);
    signal.throwIfAborted();
    if (args.action === "list") return (await readdir(source.path, { withFileTypes: true })).filter(item => item.isFile() || item.isDirectory()).map(item => ({ name: item.name, type: item.isDirectory() ? "directory" : "file" }));
    if (args.action === "readBinary") {
      const info = await stat(source.path);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw new Error("The file must be an ordinary file no larger than 20MB");
      return { path: args.path, base64: (await readFile(source.path, { signal })).toString("base64") };
    }
    protectWorkspaceRoot(directory!, source.path);
    await assertFileNotOpen(directory!, args.path);
    const destination = args.action === "rename" && args.target ? await resolveWorkspacePath(directory!, args.target) : undefined;
    if (args.action === "rename" && !destination) throw new Error("Renaming requires args.target");
    if (destination) {
      protectWorkspaceRoot(directory!, destination.path);
      destination.path = resolve(dirname(destination.path), basename(resolve(directory!, args.target!)));
    }
    const release = lockWorkspaceFiles([source.path, ...(destination ? [destination.path] : [])]);
    try {
      if (args.action === "writeBinary") {
        if (args.base64 === undefined) throw new Error("Writing binary files requires base64");
        const bytes = Buffer.from(args.base64, "base64");
        if (bytes.length > 20 * 1024 * 1024) throw new Error("The file cannot exceed 20MB");
        await writeWorkspaceFile(source.path, bytes, args.exclusive);
      } else if (args.action === "mkdir") await mkdir(source.path);
      else if (destination) await renameWorkspaceFile(source.path, destination.path);
      else if ((await lstat(source.path)).isDirectory() && !args.recursive) await rmdir(source.path);
      else await rm(source.path, { recursive: args.recursive });
    } finally { release(); }
    return { success: true };
  }));
  tools.push(wrapTool("listAppOperations", "Query plug-ins, media providers, asset libraries, and Agent history management operations and their parameters on demand. Query the schema first and then call appOperation.", z.toJSONSchema(z.strictObject({ name: z.string().optional() })), async args => {
    return appOperations.filter(item => !args.name || item.name === args.name).map(({ name, description, parameters, path }) => {
      const schema = z.toJSONSchema(parameters);
      if (path.startsWith("/api/agent/")) {
        delete schema.properties?.directory;
        schema.required = schema.required?.filter(key => key !== "directory");
      }
      return { name, description, parameters: schema };
    });
  }));
  tools.push(wrapTool("appOperation", "executes the application management operations published by listAppOperations. The parameters must conform to the corresponding schema. File and node operations use specialized tools; installation sources, overwrites, and uninstalls are subject to user requests.", z.toJSONSchema(z.strictObject({ name: z.string(), parameters: z.record(z.string(), z.json()) })), async (args, target, signal) => {
    const operation = appOperations.find(item => item.name === args.name);
    if (!operation) throw new Error("The application operation does not exist, please query listAppOperations");
    const parameters = { ...args.parameters as Record<string, unknown> };
    if (operation.path.startsWith("/api/agent/")) parameters.directory = (await resolveTarget(target)).directory;
    const result = await runAppOperation(operation.name, parameters, signal);
    const refreshErrors: string[] = [];
    if (operation.refresh) {
      const name = operation.refresh.nameField ? parameters[operation.refresh.nameField] : (result as { name?: string } | null)?.name;
      for (const connection of listConnections()) {
        try { await callControl(connection.id, "refreshResources", {
          type: operation.refresh.type, name,
          ...(operation.name === "deleteMediaProvider" ? { removedProviderId: (parameters.fileName as string).slice(0, -3) } : {}),
        }, signal); }
        catch (error) { refreshErrors.push(error instanceof Error ? error.message : String(error)); }
      }
    }
    return { result: redactSecrets(result), ...(refreshErrors.length ? { refreshErrors } : {}) };
  }));
  const runAgentSchema = z.strictObject({
    prompt: z.string().trim().min(1), providerId: z.string().min(1), modelId: z.string().min(1),
    sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(), thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  });
  tools.push(wrapTool("runAgent", "Calls the Toonflow built-in Agent according to the user's request, waits for the completion of this round and returns the conversation file and reply; the configured model will be used. External Agents can directly operate other tools and only need to be called when entrusting the built-in Agent. Supports MCP cancellation and history saving to workspace.", z.toJSONSchema(runAgentSchema), async (input, target, signal) => {
    const args = runAgentSchema.parse(input);
    const { directory, connection } = await resolveTarget(target);
    const canvas: CanvasContext | undefined = connection ? {
      id: connection.state.canvasId ?? "mcp", tools: connection.state.tools,
      call: (request, callSignal) => callControl(connection.id, request.name, request.args, callSignal ?? signal, directory),
    } : undefined;
    const blocks = new Map<string, string>();
    let sessionFile = args.sessionFile;
    await runAgent({ ...args, cwd: directory!, canvas, signal }, event => {
      if (event.type === "session") sessionFile = event.file;
      if (event.type === "text") blocks.set(event.blockId, event.content ?? (blocks.get(event.blockId) ?? "") + (event.delta ?? ""));
    });
    return { sessionFile, text: [...blocks.values()].join("\n") };
  }));
  return tools.map(tool => ({
    ...tool,
    execute(input, signal) {
      const requestSignal = AbortSignal.any([signal, authorizationSignal]);
      requestSignal.throwIfAborted();
      return tool.execute(input, requestSignal);
    },
  }));
}
