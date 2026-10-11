import { t, validationOptions } from "@/lib/i18n";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "@toonflow/file";
import { dirname, resolve } from "node:path";
import { teamLimits, teamNameSchema, teamSchema, validateTeamResources } from "@toonflow/teams-scaffold/runtime";
import conf from "@/utils/conf";
import { decodeText, skillPath } from "@/utils/plugins/install";
import { parseTool } from "@/utils/plugins/tools";
import { isWithin, lockWorkspaceFiles } from "@/utils/workspace/files";

export const agentsDirectory = resolve(dirname(conf.path), "agents");
export const maxBytes = teamLimits.maxTotalBytes;
export const installRecord = ".toonflowInstall.json";
export const teamNamePattern = /^[a-z][a-zA-Z0-9]{0,95}$/;

let pending = Promise.resolve();

export function withTeamFiles<T>(operation: () => Promise<T>): Promise<T> {
  // ACT: Team directories are at most 20 MB, so short reads/writes share
  // one queue; split into per-team or read/write locks as they grow.
  const result = pending.then(async () => {
    const release = lockWorkspaceFiles([agentsDirectory]);
    try { return await operation(); }
    finally { release(); }
  });
  pending = result.then(() => {}, () => {});
  return result;
}

export function checkName(name: string) {
  if (!teamNameSchema.safeParse(name).success) throw Object.assign(new Error("The team name must be a lowerCamelCase name of no more than 96 characters and cannot use reserved words."), { status: 400 });
  return name;
}

export function editablePath(path: string) {
  return path === "team.json" || /^members\/.+\.md$/i.test(path) || /^(skills|knowledge)\/.+/.test(path);
}

export function fingerprint(files: Map<string, Uint8Array>) {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) hash.update(path).update("\0").update(createHash("sha256").update(files.get(path)!).digest());
  return hash.digest("hex");
}

export function validateFiles(name: string, files: Map<string, Uint8Array>) {
  const raw = files.get("team.json");
  if (!raw) throw Object.assign(new Error("Team package is missing team.json"), { status: 400 });
  let manifest;
  try { manifest = teamSchema.parse(JSON.parse(decodeText(raw)), validationOptions()); }
  catch (error) { throw Object.assign(new Error(t`team.json Invalid: ${error instanceof Error ? error.message : String(error)}`), { status: 400 }); }
  if (manifest.name !== name) throw Object.assign(new Error("The team name, directory and installation file name must be consistent"), { status: 400 });
  let total = 0;
  const names = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (skillPath(path) !== path || !(editablePath(path) || /^readme\.md$/i.test(path) || /^tools\/[a-z][a-zA-Z0-9]*\.tool\.js$/.test(path))) {
      throw Object.assign(new Error(t`The team package contains unsupported files: ${path}`), { status: 400 });
    }
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const existing = names.get(prefix.toLowerCase());
      if (existing && existing !== prefix) throw Object.assign(new Error("Team file path contains case conflict"), { status: 409 });
      names.set(prefix.toLowerCase(), prefix);
    }
    total += bytes.byteLength;
    if (path.startsWith("tools/")) {
      const source = decodeText(bytes);
      parseTool(source, path.slice(6, -8));
      try {
        if (!new Bun.Transpiler({ loader: "js" }).scan(source).exports.includes("default")) throw new Error("default");
      } catch { throw Object.assign(new Error(t`Invalid private tool syntax or missing default export: ${path}`), { status: 400 }); }
    }
  }
  if (files.size > 2000 || total > maxBytes) throw Object.assign(new Error("Team packages can contain up to 2000 files, and the total file size cannot exceed 20 MB"), { status: 413 });
  try { validateTeamResources(manifest, files.keys()); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 }); }
  for (const member of Object.values(manifest.members)) {
    decodeText(files.get(member.instructions)!);
    for (const skill of member.skills ?? []) decodeText(files.get(`skills/${skill}/SKILL.md`)!);
  }
  return manifest;
}

export async function readFiles(name: string) {
  checkName(name);
  const directory = resolve(agentsDirectory, name);
  for (const path of [agentsDirectory, directory]) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error("The team directory must be a normal directory"), { status: 403 });
  }
  const actualRoot = await realpath(agentsDirectory);
  if (!isWithin(actualRoot, await realpath(directory))) throw Object.assign(new Error("Team directory is out of scope"), { status: 403 });
  const files = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let total = 0;
  let entries = 0;
  async function collect(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!prefix && entry.name === installRecord) continue;
      const path = skillPath(prefix ? `${prefix}/${entry.name}` : entry.name);
      if (++entries > 2000) throw Object.assign(new Error("Teams contain up to 2000 files and directories"), { status: 413 });
      if (names.has(path.toLowerCase())) throw Object.assign(new Error("The team directory contains a path with a case conflict"), { status: 400 });
      names.add(path.toLowerCase());
      const target = resolve(dir, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !isWithin(actualRoot, await realpath(target))) throw Object.assign(new Error("Team files cannot contain links or out-of-bounds paths"), { status: 403 });
      if (info.isDirectory()) await collect(target, path);
      else {
        if (!info.isFile()) throw Object.assign(new Error("Team cannot contain special files"), { status: 403 });
        if (total + info.size > maxBytes) throw Object.assign(new Error("Total team file size cannot exceed 20 MB"), { status: 413 });
        const bytes = await readFile(target);
        total += bytes.byteLength;
        if (total > maxBytes) throw Object.assign(new Error("Total team file size cannot exceed 20 MB"), { status: 413 });
        files.set(path, bytes);
      }
    }
  }
  await collect(directory, "");
  return { directory: await realpath(directory), files };
}
