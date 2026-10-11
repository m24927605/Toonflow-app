import { lstat, readFile } from "@toonflow/file";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { t, translateMessage } from "@/lib/i18n";
import conf from "@/utils/conf";
import { configFields, configRulesSchema, declaredConfig, validateNodeConfig } from "@/utils/plugins/nodes";

export const extNameSchema = z.string().max(96).regex(/^ext-[a-z][a-zA-Z0-9]*$/);
export const extDirectory = resolve(dirname(conf.path), "ext");
const metadataSchema = z.object({
  id: extNameSchema,
  displayName: z.string().trim().min(1),
  extensions: z.array(z.string().regex(/^[a-z0-9]+$/)),
  resourceKind: z.enum(["file", "canvasNode"]),
  text: z.boolean().optional(),
  version: z.string().trim().min(1),
  readme: z.string().default(""),
  author: z.string().default(""),
  github: z.string().default(""),
  icon: z.string().refine(icon => !icon || /^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif)(?:;[^,]*)?,/i.test(icon)
    || (URL.canParse(icon) && ["http:", "https:"].includes(new URL(icon).protocol))).optional(),
  configRules: configRulesSchema.default([]),
});

export function parseExt(source: string, name: string) {
  extNameSchema.parse(name);
  try {
    const header = source.match(/^\/\*! toonflowExt:([^\r\n]*) \*\/(?:\r?\n|$)/)?.[1];
    const metadata = metadataSchema.parse(JSON.parse(header ?? ""));
    if (metadata.id !== name || (metadata.resourceKind === "file" && !metadata.extensions.length)
      || new Set(metadata.extensions).size !== metadata.extensions.length) throw new Error("metadata");
    if (metadata.github) {
      const url = new URL(metadata.github);
      if (url.origin !== "https://github.com" || url.username || url.password) throw new Error("github");
    }
    return { name, ...metadata };
  } catch {
    throw Object.assign(new Error("Invalid file extension metadata. Rebuild it using the extension scaffold; the file name must match the extension ID"), { status: 400 });
  }
}

export async function readExt(name: string) {
  extNameSchema.parse(name);
  const path = resolve(extDirectory, `${name}.umd.js`);
  const file = await lstat(path);
  if (!file.isFile()) throw Object.assign(new Error("A file extension must be a regular file"), { status: 400 });
  if (file.size > 20 * 1024 * 1024) throw Object.assign(new Error("File extensions cannot exceed 20 MB"), { status: 413 });
  const source = await readFile(path, "utf8");
  return { ...parseExt(source, name), revision: Bun.hash(source).toString(16) };
}

export function getExtConfig(extension: { name: string; configRules: z.infer<typeof configRulesSchema> }) {
  const configs = conf.get("extConfigs", {});
  return declaredConfig(extension.configRules, Object.hasOwn(configs, extension.name) ? configs[extension.name]! : {});
}

export function validateExtConfig(rules: z.infer<typeof configRulesSchema>, config: Record<string, unknown>) {
  const parsed = validateNodeConfig(rules, config);
  for (const { rule } of configFields(rules)) {
    if (typeof rule.field !== "string" || !Object.hasOwn(parsed, rule.field)) continue;
    const value = parsed[rule.field];
    const props = rule.props && typeof rule.props === "object" && !Array.isArray(rule.props) ? rule.props : {};
    const label = translateMessage(typeof rule.title === "string" && rule.title.trim() ? rule.title : rule.field);
    let message = "";
    if (rule.type === "inputNumber") {
      if (typeof value !== "number" || !Number.isFinite(value)) message = t`${label} must be a number`;
      else if (typeof props.min === "number" && value < props.min) message = t`${label} must not be less than ${props.min}`;
      else if (typeof props.max === "number" && value > props.max) message = t`${label} must not exceed ${props.max}`;
    } else if (rule.type === "switch" && value !== (props.activeValue ?? true) && value !== (props.inactiveValue ?? false)) {
      message = t`Invalid switch value for ${label}`;
    }
    // ACT: Only validate supported standard controls; custom controls
    // keep their values. Add matching rules when adding new controls.
    if (message) throw Object.assign(new Error(message), { status: 400 });
  }
  return parsed;
}
