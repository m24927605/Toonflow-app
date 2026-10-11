import { getLocale, t, validationOptions } from "@/lib/i18n";
import { z } from "zod";
import { toolNameSchema } from "@toonflow/tools-scaffold/runtime";
import { mediaModelsSchema, mediaProviderFileSchema } from "@/utils/media/provider";
import { getMcpRuntime } from "@/utils/mcp/runtime";

const maxBytes = 20 * 1024 * 1024;
const directory = z.string().min(1).max(4096);
const path = z.string().min(1).max(4096);
const pluginName = z.string().regex(/^[a-z][a-zA-Z0-9]*$/);
const skillName = z.string().min(1).max(1024);
const skillPath = z.string().min(1).max(1024);
const sessionFile = z.string().regex(/^[\w-]+\.jsonl$/);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const base64 = z.string().max(Math.ceil(maxBytes / 3) * 4).base64();
const sourceFields = {
  source: z.string().min(1).max(maxBytes).optional(),
  url: z.url().max(4096).optional(),
  force: z.boolean().optional(),
};
const sourceRequired = (value: { fileName?: string; source?: string; url?: string }) =>
  value.url ? value.source === undefined : value.fileName !== undefined && value.source !== undefined;

export const appOperations: {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  parameters: z.ZodType;
  refresh?: { type: "node" | "tool" | "skill" | "provider"; nameField?: string };
}[] = [
  {
    name: "listNodes", description: "Lists the metadata, description, and enablement status of installed nodes.", method: "GET", path: "/api/nodes/get", parameters: z.strictObject({}),
  },
  {
    name: "setNodeEnabled", description: "Enables or disables installed nodes.", method: "PUT", path: "/api/nodes/setEnabled",
    parameters: z.strictObject({ name: pluginName, enabled: z.boolean() }), refresh: { type: "node", nameField: "name" },
  },
  {
    name: "installNode", description: "Install node UMD via fileName/source, or download using url; force explicitly allows overrides. Downloading and version checking follow the existing installation interface.", method: "POST", path: "/api/nodes/install",
    parameters: z.strictObject({ ...sourceFields, fileName: z.string().max(128).optional() }).refine(sourceRequired, "Provide url or fileName/source, not both url and source."), refresh: { type: "node" },
  },
  {
    name: "uninstallNode", description: "Uninstalls the specified node plugin without deleting the canvas and node output of the workspace.", method: "DELETE", path: "/api/nodes/uninstall",
    parameters: z.strictObject({ name: pluginName }), refresh: { type: "node", nameField: "name" },
  },
  {
    name: "listTools", description: "List installed tools, their descriptions, enabled states, and configurations. MCP masks access credentials in its output.", method: "GET", path: "/api/tools/get", parameters: z.strictObject({}),
  },
  {
    name: "setToolEnabled", description: "Enable or disable the tool; when enabled, the tool configuration verification is used.", method: "PUT", path: "/api/tools/setEnabled",
    parameters: z.strictObject({ name: toolNameSchema, enabled: z.boolean() }), refresh: { type: "tool", nameField: "name" },
  },
  {
    name: "saveToolConfig", description: "Save the specified tool's complete config and validate it against the tool's configuration rules. Do not write back masked placeholders.", method: "PUT", path: "/api/tools/save",
    parameters: z.strictObject({ name: toolNameSchema, config: z.record(z.string(), z.json()) }), refresh: { type: "tool", nameField: "name" },
  },
  {
    name: "installTool", description: "Install .tool.js via fileName/source, or download using url; force explicitly allows overwriting.", method: "POST", path: "/api/tools/install",
    parameters: z.strictObject({ ...sourceFields, fileName: z.string().max(104).regex(/^[a-z][a-zA-Z0-9]*\.tool\.js$/).optional() }).refine(sourceRequired, "Provide url or fileName/source, not both url and source."), refresh: { type: "tool" },
  },
  {
    name: "uninstallTool", description: "Uninstalls the specified tool and deletes its configuration.", method: "DELETE", path: "/api/tools/uninstall",
    parameters: z.strictObject({ name: toolNameSchema }), refresh: { type: "tool", nameField: "name" },
  },
  {
    name: "listSkills", description: "Lists metadata for globally installed skills; workspace skills reuse the skillOperator tool.", method: "GET", path: "/api/skills/get", parameters: z.strictObject({}),
  },
  {
    name: "listSkillFiles", description: "Lists the file and main file path of the specified global skill.", method: "GET", path: "/api/skills/list", parameters: z.strictObject({ name: skillName }),
  },
  {
    name: "readSkillFile", description: "Reads the UTF-8 file of the specified global skill; when path is omitted, the main SKILL.md is read.", method: "GET", path: "/api/skills/read",
    parameters: z.strictObject({ name: skillName, path: skillPath.optional() }),
  },
  {
    name: "createSkillFile", description: "Create a new blank file within the installed skill without overwriting the existing file; please use installSkill or skillOperator for new skills.", method: "POST", path: "/api/skills/create",
    parameters: z.strictObject({ name: skillName, path: skillPath }), refresh: { type: "skill", nameField: "name" },
  },
  {
    name: "saveSkillFile", description: "Saves an existing skill file; the main SKILL.md must retain the same frontmatter name and valid description.", method: "PUT", path: "/api/skills/save",
    parameters: z.strictObject({ name: skillName, path: skillPath.optional(), content: z.string().max(maxBytes) }), refresh: { type: "skill", nameField: "name" },
  },
  {
    name: "moveSkillFile", description: "Move or rename files within the specified skill without overwriting existing targets.", method: "PUT", path: "/api/skills/move",
    parameters: z.strictObject({ name: skillName, path: skillPath, target: skillPath }), refresh: { type: "skill", nameField: "name" },
  },
  {
    name: "installSkill", description: "Use fileName/base64 to install the skill file or compressed package, or use url to download; force explicitly allows overwriting.", method: "POST", path: "/api/skills/install",
    parameters: z.strictObject({ fileName: z.string().max(128).optional(), base64: base64.min(1).optional(), url: z.url().max(4096).optional(), force: z.boolean().optional() })
      .refine(value => value.url ? value.base64 === undefined : value.fileName !== undefined && value.base64 !== undefined, "Provide url or fileName/base64, not both url and base64"), refresh: { type: "skill" },
  },
  {
    name: "uninstallSkill", description: "Uninstalling global skills and their files does not affect the skills with the same name in the workspace.", method: "DELETE", path: "/api/skills/uninstall",
    parameters: z.strictObject({ name: skillName }), refresh: { type: "skill", nameField: "name" },
  },
  {
    name: "listMediaProviders", description: "Read the media provider and preset models and configuration revision; use the latest revision when saving and deleting.", method: "GET", path: "/api/providers/media/list", parameters: z.strictObject({}),
  },
  {
    name: "addMediaProvider", description: "Add media providers from full TypeScript source, inheriting existing provider structure checks.", method: "POST", path: "/api/providers/media/add",
    parameters: z.strictObject({ source: z.string().min(1).max(2 * 1024 * 1024) }), refresh: { type: "provider" },
  },
  {
    name: "saveMediaProviderModels", description: "Modify models in provider TS; refuse to overwrite if revision does not match. Credentials such as API Key are configured through updateSettings.", method: "PUT", path: "/api/providers/media/save",
    parameters: z.strictObject({ fileName: mediaProviderFileSchema, models: mediaModelsSchema, revision }), refresh: { type: "provider", nameField: "fileName" },
  },
  {
    name: "deleteMediaProvider", description: "Removes the specified media provider and its saved configuration; the current revision must be provided.", method: "DELETE", path: "/api/providers/media/delete",
    parameters: z.strictObject({ fileName: mediaProviderFileSchema, revision }), refresh: { type: "provider", nameField: "fileName" },
  },
  {
    name: "listAssets", description: "Lists the file and folder tree of the global library; distinct from the workspace assets directory.", method: "GET", path: "/api/assets/list", parameters: z.strictObject({}),
  },
  {
    name: "createAssetDirectory", description: "Create a folder in the global asset library, and path is the relative path in the asset library.", method: "POST", path: "/api/assets/mkdir", parameters: z.strictObject({ path }),
  },
  {
    name: "renameAsset", description: "Move or rename files and folders in the global asset library without overwriting existing targets.", method: "POST", path: "/api/assets/rename", parameters: z.strictObject({ path, target: path }),
  },
  {
    name: "removeAsset", description: "Delete files or empty folders from the global library without deleting content recursively.", method: "DELETE", path: "/api/assets/remove", parameters: z.strictObject({ path }),
  },
  {
    name: "readAsset", description: "Read a file of up to 20 MB from the global asset library, returning base64 data and its MIME type.", method: "GET", path: "/api/assets/read", parameters: z.strictObject({ path }),
  },
  {
    name: "saveAsset", description: "Upload files no larger than 20 MB to the global asset library using base64; existing files will not be overwritten, and the parent folder must exist.", method: "PUT", path: "/api/assets/save", parameters: z.strictObject({ path, base64 }),
  },
  {
    name: "listAgentSessions", description: "Lists built-in Agent history conversations for the target workspace. directory is injected by target.directory.", method: "GET", path: "/api/agent/list", parameters: z.strictObject({ directory }),
  },
  {
    name: "createAgentSession", description: "Create a new built-in Agent conversation in the target workspace without starting generation. directory is injected from target.directory.", method: "POST", path: "/api/agent/create", parameters: z.strictObject({ directory }),
  },
  {
    name: "getAgentSession", description: "Read the built-in Agent conversation history, sessionFile comes from listAgentSessions. directory is injected by target.directory.", method: "GET", path: "/api/agent/get", parameters: z.strictObject({ directory, sessionFile }),
  },
  {
    name: "renameAgentSession", description: "Modifies the built-in Agent conversation name; directory is injected by target.directory.", method: "PATCH", path: "/api/agent/rename", parameters: z.strictObject({ directory, sessionFile, name: z.string().trim().min(1).max(80) }),
  },
];

export async function runAppOperation(name: string, parameters: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const operation = appOperations.find(item => item.name === name);
  if (!operation) throw new Error(t`Unknown application operation: ${name}`);
  const args = operation.parameters.parse(parameters, validationOptions()) as Record<string, unknown>;
  const origin = getMcpRuntime().appOrigin;
  if (!origin) throw new Error("Toonflow service is not ready yet");
  const url = new URL(operation.path, origin);
  const headers: Record<string, string> = { "x-toonflow-workspace": "1", Origin: origin, Referer: `${origin}/`, "Accept-Language": getLocale() };
  let body: string | ArrayBuffer | undefined;
  if (operation.name === "saveAsset") {
    url.searchParams.set("path", args.path as string);
    body = new Uint8Array(Buffer.from(args.base64 as string, "base64")).buffer;
    if (body.byteLength > maxBytes) throw new Error("Asset file cannot exceed 20 MB");
    headers["Content-Type"] = "application/octet-stream";
  } else if (operation.method === "GET") {
    for (const [key, value] of Object.entries(args)) if (value !== undefined) url.searchParams.set(key, String(value));
  } else {
    body = JSON.stringify(args, (_key, value) => {
      if (value === "[REDACTED]") throw new Error("Cannot save a masked placeholder; enter the actual value");
      return value;
    });
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, { method: operation.method, headers, body, signal, redirect: "error" });
  if (operation.name === "readAsset" && response.ok) {
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel();
      throw new Error("Asset file cannot exceed 20 MB");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Asset file cannot exceed 20 MB");
    return { path: args.path, mimeType: response.headers.get("content-type"), base64: bytes.toString("base64") };
  }
  const result = await response.json() as { code?: number; data?: unknown; message?: string };
  if (!response.ok || result.code !== 200) throw new Error(result.message || t`Application operation failed (${response.status})`);
  return result.data ?? null;
}
