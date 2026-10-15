import { copyFile, cp, mkdir, readFile, readdir, rename, rm, unlink, writeAtomic, writeFile } from "@toonflow/file";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

export default async function initializePlugins(targetDirectory: string, sourceDirectory: string, fileFilter?: RegExp | readonly string[], revision?: string) {
  const marker = resolve(targetDirectory, "initialized");
  const initialized = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (initialized !== null && (revision === undefined || initialized === revision)) return;

  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entries) return;
  await mkdir(targetDirectory, { recursive: true });
  const files = entries.filter(file => fileFilter
    ? file.isFile() && (fileFilter instanceof RegExp ? fileFilter.test(file.name) : fileFilter.includes(file.name))
    : file.isDirectory());
  if (!files.length && revision === undefined) return;
  for (const file of files) {
    const source = resolve(sourceDirectory, file.name);
    const target = resolve(targetDirectory, file.name);
    if (revision === undefined) {
      await cp(source, target, { recursive: true, force: false });
      continue;
    }
    // ACT: Version sync only overwrites matching built-in single
    // files; a same-directory rename keeps the old file on failure.
    const temporary = resolve(targetDirectory, `.pluginSync${crypto.randomUUID()}`);
    try {
      await copyFile(source, temporary);
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
        if (cleanupError.code !== "ENOENT") console.warn(`Failed to clean up plugin sync temporary files: ${temporary}`, cleanupError);
      });
      throw error;
    }
  }
  // Sync once per build; the installer removes the marker to allow
  // same-version reinstalls, and build changes allow upgrades and downgrades.
  await (revision === undefined ? writeFile(marker, "", { flag: "wx" }) : writeAtomic(marker, revision, { mode: 0o666 })).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/** A hash of every file under these entries of `root`, by path relative to it, so an edit anywhere changes it. */
async function treeRevision(root: string, names: string[]) {
  const hash = createHash("sha256");
  for (const name of names) {
    const entries = await readdir(resolve(root, name), { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    });
    const files = entries.filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name)).sort();
    for (const file of files) hash.update(relative(root, file).replaceAll("\\", "/")).update("\0").update(await readFile(file)).update("\0");
  }
  return hash.digest("hex");
}

/**
 * Installs the built-in folders, such as skills, and replaces them when a build ships new ones, unless someone edited
 * the installed copy since: the marker holds the revision installed, and an edited copy no longer matches it and is
 * kept as it is. Folders that are not built in are never touched.
 */
export async function syncEditablePlugins(targetDirectory: string, sourceDirectory: string) {
  const names = (await readdir(sourceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (!names.length) return;
  const marker = resolve(targetDirectory, "initialized");
  const recorded = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const latest = await treeRevision(sourceDirectory, names);
  if (recorded === latest) return;
  if (recorded !== null && recorded !== await treeRevision(targetDirectory, names)) {
    console.warn(`[plugins] ${targetDirectory} was edited, so it keeps those edits instead of the built-in update`);
    return;
  }
  await mkdir(targetDirectory, { recursive: true });
  for (const name of names) {
    await rm(resolve(targetDirectory, name), { recursive: true, force: true });
    await cp(resolve(sourceDirectory, name), resolve(targetDirectory, name), { recursive: true });
  }
  await writeAtomic(marker, latest, { mode: 0o666 });
}
