import { t, translateMessage, validationOptions } from "@/lib/i18n";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "@toonflow/file";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as zod from "zod";
import { toolMetadataSchema, toolNameSchema, type ToolMetadata, type ToolPlugin } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";

export { toolNameSchema } from "@toonflow/tools-scaffold/runtime";

const { z } = zod;

// ACT: Tools reuse the host's Zod 4; the virtual module does not depend on node_modules in the install directory.
Bun.plugin({
  name: "toolHost",
  setup(build) {
    build.module("toonflow:tool-zod", () => ({ exports: zod, loader: "object" }));
  },
});

export const toolsDirectory = resolve(dirname(conf.path), "tools");

export function parseTool(source: string, name: string) {
  let metadata: zod.infer<typeof toolMetadataSchema>;
  try {
    const header = source.match(/^\/\*! toonflowTool:([^\r\n]*) \*\/(?:\r?\n|$)/)?.[1];
    metadata = toolMetadataSchema.parse(JSON.parse(header ?? ""));
    if (metadata.name !== name) throw new Error("name");
  } catch {
    throw Object.assign(new Error("The tool metadata is invalid, or the file name is inconsistent with the tool name."), { status: 400 });
  }
  const client = parseToolClient(source);
  if (metadata.components.length && !client) throw Object.assign(new Error("Tool declares component but lacks client interface"), { status: 400 });
  return { metadata, client };
}

function parseToolClient(source: string) {
  const line = source.split(/\r?\n/, 2)[1];
  if (!line?.startsWith("/*! toonflowToolClient:")) return;
  try {
    const data = line.match(/^\/\*! toonflowToolClient:([^\r\n]*) \*\/$/)?.[1];
    const client = z.strictObject({ code: z.string().min(1).refine(code => !!code.trim()), css: z.string() }).parse(JSON.parse(data ?? ""));
    new Bun.Transpiler({ loader: "js" }).scan(client.code);
    return client;
  } catch {
    throw Object.assign(new Error("The tool client interface format or script syntax is invalid."), { status: 400 });
  }
}

export async function readTool(name: string, directory = toolsDirectory) {
  toolNameSchema.parse(name, validationOptions());
  const path = resolve(directory, `${name}.tool.js`);
  const file = await lstat(path);
  if (!file.isFile()) throw Object.assign(new Error("The tool file is invalid"), { status: 400 });
  if (file.size > 20 * 1024 * 1024) throw Object.assign(new Error("Tool file cannot exceed 20 MB"), { status: 400 });
  const source = await readFile(path, "utf8");
  return { path, source, revision: createHash("sha256").update(source).digest("hex"), ...parseTool(source, name) };
}

export function getToolConfig(metadata: ToolMetadata): Record<string, unknown> {
  const defaults = Object.fromEntries(metadata.configRules
    .filter(rule => typeof rule.field === "string" && rule.value !== undefined)
    .map(rule => [rule.field, rule.value]));
  const saved = conf.get("toolConfigs", {});
  return { ...defaults, ...(Object.hasOwn(saved, metadata.name) ? saved[metadata.name] : {}) };
}

export async function listTools() {
  const files = await readdir(toolsDirectory, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  return Promise.all(files.filter(file => file.isFile() && /^[a-z][a-zA-Z0-9]*\.tool\.js$/.test(file.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async file => {
      const name = file.name.slice(0, -8);
      const enabled = !files.some(entry => entry.name === `${name}.disabled`);
      try {
        const { metadata, revision } = await readTool(name);
        return { ...metadata, enabled, config: getToolConfig(metadata), revision, loadError: "" };
      } catch (err) {
        const loadError = translateMessage(err instanceof Error ? err.message : "Tool file cannot be read");
        return { name, version: "", displayName: name, description: loadError, author: "", github: "", components: [], configRules: [], enabled, config: {}, revision: "", loadError };
      }
    }));
}

export async function loadTool(name: string, directory = toolsDirectory) {
  const { path, metadata } = await readTool(name, directory);
  // ACT: Tools are trusted server-side code, not sandboxed; the
  // installer clears the module cache after a successful install.
  const { default: plugin } = await import(pathToFileURL(path).href) as { default: ToolPlugin };
  if (typeof plugin?.createTools !== "function" || typeof plugin.validateConfig !== "function") {
    throw Object.assign(new Error(t`${metadata.displayName} did not export a valid tool plugin`), { status: 400 });
  }
  return { plugin, metadata };
}

export function validateToolConfig(plugin: ToolPlugin, config: Record<string, unknown>) {
  try {
    return plugin.validateConfig(config);
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error("Tool configuration is invalid"), { status: 400 });
  }
}
