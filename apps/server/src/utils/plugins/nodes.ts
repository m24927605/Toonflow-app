import { t, translateMessage } from "@/lib/i18n";
import { lstat, readFile } from "@toonflow/file";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import conf from "@/utils/conf";

export const nodeNameSchema = z.string().max(96).regex(/^[a-z][a-zA-Z0-9]*$/);
export const nodesDirectory = resolve(dirname(conf.path), "nodes");
export const configRulesSchema = z.array(z.record(z.string(), z.json())).max(100);
type ConfigRule = z.infer<typeof configRulesSchema>[number];

export async function readNode(name: string) {
  nodeNameSchema.parse(name);
  const path = resolve(nodesDirectory, `${name}.umd.js`);
  const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw Object.assign(error, { status: 404, message: "节点不存在" });
    throw error;
  });
  if (!file.isFile()) throw Object.assign(new Error("节点文件无效"), { status: 400 });
  // ACT: Reads whole bundles for now, so memory grows with total
  // node size; read only the first line once nodes or bundles grow.
  const source = await readFile(path, "utf8");
  let metadata: Record<string, unknown> = {};
  try {
    const header = source.match(/^\/\*! toonflowNode:([^\r\n]*) \*\/(?:\r?\n|$)/)?.[1];
    const parsed = header ? JSON.parse(header) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    // Missing or corrupt metadata falls back to the file name without executing the node script.
  }
  let github = "";
  if (typeof metadata.github === "string" && URL.canParse(metadata.github)) {
    const url = new URL(metadata.github);
    if (url.origin === "https://github.com" && !url.username && !url.password) github = url.href;
  }
  const rules = configRulesSchema.safeParse(metadata.configRules ?? []);
  if (!rules.success) throw Object.assign(new Error("节点配置表单规则无效，请重新构建节点"), { status: 400 });
  return {
    name,
    displayName: typeof metadata.displayName === "string" && metadata.displayName.trim() ? metadata.displayName : name,
    version: typeof metadata.version === "string" ? metadata.version.trim() : "",
    author: typeof metadata.author === "string" ? metadata.author : "",
    readme: typeof metadata.readme === "string" ? metadata.readme : "",
    github,
    configRules: rules.data,
  };
}

export function configFields(rules: ConfigRule[], conditional = false): { rule: ConfigRule; conditional: boolean }[] {
  return rules.flatMap(rule => {
    const children = Array.isArray(rule.children) ? rule.children.filter(item => item && typeof item === "object" && !Array.isArray(item)) as ConfigRule[] : [];
    const controls = Array.isArray(rule.control) ? rule.control.flatMap(control => control && typeof control === "object" && !Array.isArray(control)
      && Array.isArray(control.rule) ? control.rule.filter(item => item && typeof item === "object" && !Array.isArray(item)) as ConfigRule[] : []) : [];
    return [{ rule, conditional }, ...configFields(children, conditional), ...configFields(controls, true)];
  });
}

export function declaredConfig(rules: ConfigRule[], config: Record<string, unknown>) {
  return Object.fromEntries(configFields(rules).map(({ rule }) => rule)
    .filter(rule => typeof rule.field === "string" && rule.field.length > 0)
    .flatMap(rule => {
      const field = rule.field as string;
      const value = Object.hasOwn(config, field) ? config[field] : rule.value;
      return value === undefined ? [] : [[field, value]];
    }));
}

export function getNodeConfig(node: { name: string; configRules: ConfigRule[] }) {
  const configs = conf.get("nodeConfigs", {});
  return declaredConfig(node.configRules, Object.hasOwn(configs, node.name) ? configs[node.name]! : {});
}

export function validateNodeConfig(rules: ConfigRule[], config: Record<string, unknown>) {
  const parsed = declaredConfig(rules, config);
  for (const { rule, conditional } of configFields(rules)) {
    const required = rule.required === true || (Array.isArray(rule.validate) && rule.validate.some(validation =>
      validation && typeof validation === "object" && !Array.isArray(validation) && validation.required === true));
    if (!required || typeof rule.field !== "string" || !rule.field) continue;
    // ACT: The form decides whether conditional controls are submitted; hidden, unsubmitted fields skip required validation.
    if (conditional && !Object.hasOwn(config, rule.field)) continue;
    const value = Object.hasOwn(parsed, rule.field) ? parsed[rule.field] : undefined;
    if (value == null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length)) {
      const label = typeof rule.title === "string" && rule.title.trim() ? rule.title : rule.field;
      throw Object.assign(new Error(t`请填写${translateMessage(label)}`), { status: 400 });
    }
  }
  return parsed;
}
