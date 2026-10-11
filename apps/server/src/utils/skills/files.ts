import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { lstat, readdir, readFile, realpath, rm } from "@toonflow/file";
import { basename, dirname, relative, resolve, sep } from "node:path";
import conf from "@/utils/conf";
import { isWithin, writeWorkspaceFile } from "@/utils/workspace/files";

export const maxBytes = 20 * 1024 * 1024;
// Record the manual order of supporting files without renaming real files, so relative links inside SKILL.md are unaffected.
const orderFileName = ".toonflowOrder.json";

export function directory() {
  return resolve(dirname(conf.path), "skills");
}

export function isEnabled(name: string) {
  return !conf.get("disabledSkills", []).includes(name);
}

export async function setEnabled(name: string, enabled: boolean) {
  await resolveSkill(name);
  const disabledSkills = new Set(conf.get("disabledSkills", []));
  if (enabled) disabledSkills.delete(name);
  else disabledSkills.add(name);
  conf.set("disabledSkills", [...disabledSkills]);
}

async function verifyRoot() {
  const root = directory();
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw Object.assign(new Error("The skill root directory must be a non-symbolic link directory"), { status: 403 });
  }
  return { root, actualRoot: await realpath(root) };
}

async function verifyChain(actualRoot: string, start: string, target: string, finalKind: "file" | "directory" = "file") {
  let path = start;
  for (const part of relative(start, target).split(sep)) {
    path = resolve(path, part);
    const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      throw Object.assign(new Error(err.code === "ENOENT" ? "file does not exist" : "Invalid skill path"), { status: err.code === "ENOENT" ? 404 : 403 });
    });
    const isFinal = path === target;
    const expectDirectory = !isFinal || finalKind === "directory";
    if (info.isSymbolicLink() || (expectDirectory ? !info.isDirectory() : !info.isFile()) || !isWithin(actualRoot, await realpath(path))) {
      throw Object.assign(new Error("The skill path cannot contain symbolic links, special files, or out-of-bounds directories"), { status: 403 });
    }
    if (isFinal && finalKind === "file" && info.size > maxBytes) throw Object.assign(new Error("Skill file cannot exceed 20 MB"), { status: 413 });
  }
}

// ACT: Install/export and the editor share segment-name rules but keep their own path normalization.
export function isSafeSegment(part: string) {
  return !!part && part !== "." && part !== ".."
    && !/[\\/<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(part.split(".")[0]!.trimEnd());
}

function validatePath(path: string) {
  const parts = path.split(/[\\/]/);
  if (!parts.length || parts.some(part => !isSafeSegment(part))) {
    throw Object.assign(new Error("Invalid file path"), { status: 400 });
  }
  return parts;
}

async function resolveSkill(name: string) {
  const { root, actualRoot } = await verifyRoot();
  const skill = loadSkillsFromDir({ dir: root, source: "user" }).skills.find(skill => skill.name === name);
  if (!skill) throw Object.assign(new Error("Skill does not exist"), { status: 404 });
  const mainTarget = resolve(skill.filePath);
  if (mainTarget === root || !isWithin(root, mainTarget)) throw Object.assign(new Error("The skill file exceeds the directory range"), { status: 403 });
  await verifyChain(actualRoot, root, mainTarget);
  const baseDir = dirname(mainTarget);
  // Only browse/edit supporting files when the skill is a dedicated folder directly under the
  // skills root (as installs always create it); avoids exposing the root or other skills.
  const isDirectorySkill = basename(mainTarget) === "SKILL.md" && dirname(baseDir) === root;
  return { root, actualRoot, mainTarget, baseDir, isDirectorySkill };
}

export async function uninstall(name: string) {
  const { mainTarget, baseDir, isDirectorySkill } = await resolveSkill(name);
  if (isDirectorySkill) {
    const entries = await readdir(baseDir, { recursive: true, withFileTypes: true });
    if (entries.some(entry => entry.name.toLowerCase() === "skill.md" && resolve(entry.parentPath, entry.name) !== mainTarget)) {
      throw Object.assign(new Error("The directory contains other skills and cannot be uninstalled as a whole."), { status: 409 });
    }
  }
  // ACT: For non-standard layouts only delete the main file, keeping a directory that may be shared with other skills.
  await rm(isDirectorySkill ? baseDir : mainTarget, { recursive: isDirectorySkill });
  conf.set("disabledSkills", conf.get("disabledSkills", []).filter(item => item !== name));
}

export async function locate(name: string, path?: string) {
  const { actualRoot, mainTarget, baseDir, isDirectorySkill } = await resolveSkill(name);
  if (!path) return { target: mainTarget, isMain: true };
  if (!isDirectorySkill) throw Object.assign(new Error("This skill has no editable attachments."), { status: 400 });
  const parts = validatePath(path);
  if (parts.length === 1 && parts[0]!.toLowerCase() === orderFileName.toLowerCase()) {
    throw Object.assign(new Error("This file is managed by the system and cannot be edited directly."), { status: 403 });
  }
  const target = resolve(baseDir, path);
  if (!isWithin(baseDir, target)) throw Object.assign(new Error("File path exceeds skill directory"), { status: 403 });
  await verifyChain(actualRoot, baseDir, target);
  return { target, isMain: target === mainTarget };
}

// Shared by new-file and move targets: the parent directory must exist and the target itself must not.
export async function resolveNewFile(name: string, path: string) {
  const { actualRoot, baseDir, isDirectorySkill } = await resolveSkill(name);
  if (!isDirectorySkill) throw Object.assign(new Error("This skill has no editable attachments."), { status: 400 });
  const parts = validatePath(path);
  const leaf = parts.at(-1)!.toLowerCase();
  if (leaf === "skill.md" || leaf === orderFileName.toLowerCase()) {
    throw Object.assign(new Error("Cannot create or move a file to this reserved filename"), { status: 400 });
  }
  const target = resolve(baseDir, path);
  if (!isWithin(baseDir, target)) throw Object.assign(new Error("File path exceeds skill directory"), { status: 403 });
  const parent = dirname(target);
  if (parent !== baseDir) await verifyChain(actualRoot, baseDir, parent, "directory");
  const exists = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
  if (exists) throw Object.assign(new Error("A file or directory with the same name already exists"), { status: 409 });
  return target;
}

export async function move(name: string, sourcePath: string, targetPath: string) {
  const { target: source, isMain } = await locate(name, sourcePath);
  if (isMain) throw Object.assign(new Error("Cannot move main file"), { status: 400 });
  const target = await resolveNewFile(name, targetPath);
  return { source, target };
}

async function readOrder(baseDir: string) {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolve(baseDir, orderFileName), "utf8"));
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string") ? parsed : [];
  } catch { return []; }
}

export async function list(name: string) {
  const { root, actualRoot, mainTarget, baseDir, isDirectorySkill } = await resolveSkill(name);
  const mainPath = relative(root, mainTarget).split(sep).join("/");
  if (!isDirectorySkill) return { mainPath, files: [mainPath] };
  const files: string[] = [];
  async function walk(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (!prefix && entry.name === orderFileName)) continue;
      if (files.length >= 2000) throw Object.assign(new Error("There are too many skill files to list."), { status: 413 });
      const entryPath = resolve(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isWithin(actualRoot, await realpath(entryPath))) await walk(entryPath, relPath);
      } else if (entry.isFile() && isWithin(actualRoot, await realpath(entryPath))) {
        files.push(relPath);
      }
    }
  }
  await walk(baseDir, "");
  const known = new Set(files);
  const order = (await readOrder(baseDir)).filter(path => path !== "SKILL.md" && known.has(path));
  const ordered = new Set(order);
  const remaining = files.filter(path => path !== "SKILL.md" && !ordered.has(path)).sort((left, right) => left.localeCompare(right));
  return { mainPath: "SKILL.md", files: ["SKILL.md", ...order, ...remaining] };
}

export async function saveOrder(name: string, order: string[]) {
  const { baseDir, isDirectorySkill } = await resolveSkill(name);
  if (!isDirectorySkill) throw Object.assign(new Error("This skill has no editable attachments."), { status: 400 });
  if (new Set(order).size !== order.length) throw Object.assign(new Error("The file order list contains duplicate paths"), { status: 400 });
  const { files } = await list(name);
  const known = new Set(files);
  if (order.some(path => path === "SKILL.md" || !known.has(path))) {
    throw Object.assign(new Error("The file order list contains invalid or nonexistent files"), { status: 400 });
  }
  await writeWorkspaceFile(resolve(baseDir, orderFileName), JSON.stringify(order));
}
