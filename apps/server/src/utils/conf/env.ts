import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { readFile } from "@toonflow/file";
import { t } from "@/lib/i18n";

const envReference = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Resolves a user setting written as `env:NAME`, so secrets can stay out of settings.json. The Toonflow process
 * environment wins, then `~/.env`, because desktop apps launched from the GUI do not inherit shell variables.
 * Any other value is returned unchanged. The file is read on every call so edits apply without a restart.
 */
export async function resolveEnvReference(value: unknown) {
  const name = typeof value === "string" ? envReference.exec(value.trim())?.[1] : undefined;
  if (!name) return value;
  if (process.env[name]) return process.env[name];
  const file = await readFile(join(homedir(), ".env"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const resolved = parseEnv(file)[name];
  if (!resolved) throw Object.assign(new Error(t`环境变量 ${name} 未设置，请在 Toonflow 进程环境或 ~/.env 中设置`), { status: 400 });
  return resolved;
}
