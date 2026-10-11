import { constants, copyFile, cp, lstat, mkdir, rename, unlink, realpath, writeAtomic } from "@toonflow/file";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Request } from "express";
import { resolveWorkspace } from "@/utils/workspace";

export async function writeWorkspaceFile(path: string, content: string | Uint8Array, exclusive = false) {
  await writeAtomic(path, content, { exclusive });
}

export async function copyWorkspaceFile(source: string, target: string) {
  const info = await lstat(source);
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw Object.assign(new Error("Only regular files or folders can be copied"), { status: 403 });
  if (!info.isDirectory()) return copyFile(source, target, constants.COPYFILE_EXCL);
  if (isWithin(source, target)) throw Object.assign(new Error("A folder cannot be copied into itself or one of its subfolders"), { status: 400 });
  await mkdir(target);
  try {
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      async filter(path) {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || !isWithin(source, await realpath(path))) {
          throw new Error("Folders containing symbolic links or special files cannot be copied");
        }
        return true;
      },
    });
  } catch (cause) {
    // ACT: Keep copied content on failure; do not recursively roll
    // back a target directory that may have received external files.
    throw Object.assign(new Error(`Copy did not complete; the content already copied is kept in ${target}. ${cause instanceof Error ? cause.message : "Please check file permissions and try again"}`, { cause }), { code: "ECOPYINCOMPLETE" });
  }
}

export async function renameWorkspaceFile(source: string, target: string) {
  const info = await lstat(source);
  if (source === target || (process.platform === "win32" && source.toLowerCase() === target.toLowerCase())) {
    if (source !== target) await rename(source, target);
    return;
  }
  if (info.isDirectory()) {
    const exists = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
    if (exists) throw Object.assign(new Error("A file or directory with the same name already exists"), { code: "EEXIST" });
    await rename(source, target);
    return;
  }
  await copyFile(source, target, constants.COPYFILE_EXCL);
  // ACT: Remove the source only after the target is fully written; if removal fails, roll back only this target.
  try { await unlink(source); }
  catch (err) {
    await unlink(target).catch(error => console.warn(`Rename rollback failed: ${target}`, error));
    throw err;
  }
}

export function isWithin(root: string, path: string) {
  const offset = relative(root, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

export async function resolveWorkspaceFile(req: Request, directory: string, path: string) {
  const root = await resolveWorkspace(req, directory);
  return resolveWorkspacePath(root, path);
}

export async function resolveWorkspacePath(root: string, path: string, allowMissingParents = false) {
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || /[<>:"|?*\x00-\x1f]/.test(part)
    || (process.platform === "win32" && part !== "." && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) {
    throw Object.assign(new Error("Invalid file path"), { status: 400 });
  }
  const target = resolve(root, path);
  const info = await lstat(target).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
  if (info?.isSymbolicLink()) throw Object.assign(new Error("Cannot operate file through symbolic link"), { status: 403 });
  let parent = dirname(target);
  if (!info && allowMissingParents) {
    while (!(await lstat(parent).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; }))) parent = dirname(parent);
  }
  const actual = info ? await realpath(target) : resolve(await realpath(parent), relative(parent, target));
  if (!isWithin(root, actual)) throw Object.assign(new Error("File operations are limited to the current workspace"), { status: 403 });
  return { directory: root, path: actual };
}

// ACT: The server is single-process; the
// lock keeps concurrent file operations from overwriting each other.
const busyFiles = new Set<string>();
export function lockWorkspaceFiles(paths: string[]) {
  const keys = paths.map(path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  if (keys.some(path => [...busyFiles].some(busy => isWithin(path, busy) || isWithin(busy, path)))) {
    throw Object.assign(new Error("The file is in use, please wait for the operation to complete."), { status: 409, code: "EBUSY" });
  }
  keys.forEach(path => busyFiles.add(path));
  return () => keys.forEach(path => busyFiles.delete(path));
}

export function protectWorkspaceRoot(directory: string, path: string) {
  if (directory === path) throw Object.assign(new Error("Cannot modify the workspace root directory"), { status: 400 });
}
