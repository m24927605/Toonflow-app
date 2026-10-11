import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "@toonflow/file";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import conf from "@/utils/conf";
import { decodeText, requireNewerVersion, skillZip } from "@/utils/plugins/install";
import { isWithin } from "@/utils/workspace/files";
import { agentsDirectory, checkName, fingerprint, installRecord, maxBytes, readFiles, validateFiles, withTeamFiles } from "./files";

const require = createRequire(import.meta.url);

export async function installTeam(fileName: string, bytes: Uint8Array, force = false) {
  if (!/^[a-z][a-zA-Z0-9]*\.agent\.zip$/.test(fileName) || fileName.length > 128) {
    throw Object.assign(new Error("Select a team package with a lowerCamelCase filename ending in .agent.zip"), { status: 400 });
  }
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw Object.assign(new Error("Team package cannot be empty and cannot exceed 20 MB"), { status: 413 });
  const name = checkName(fileName.slice(0, -10));
  // ACT: Shares ZIP validation with skill installs; never runs bundled tools or extracts to uncontrolled paths.
  const archive = skillZip(bytes);
  const prefix = archive.has("team.json") ? "" : `${name}/`;
  if (!archive.has(`${prefix}team.json`) || [...archive.keys()].some(path => !path.startsWith(prefix))) {
    throw Object.assign(new Error("The team package must contain team.json in the root directory or a directory with the same name, and all files must be located in this directory"), { status: 400 });
  }
  const files = new Map([...archive].map(([path, content]) => [path.slice(prefix.length), content]));
  const manifest = validateFiles(name, files);
  return withTeamFiles(async () => {
    const root = dirname(conf.path);
    let temporary: string | undefined;
    let preserveBackup = false;
    try {
      await mkdir(agentsDirectory, { recursive: true });
      if (!(await lstat(agentsDirectory)).isDirectory()) throw Object.assign(new Error("The team directory must be a normal directory"), { status: 403 });
      const existing = (await readdir(agentsDirectory)).find(item => item.toLowerCase() === name.toLowerCase());
      if (Object.keys(conf.get("remoteConnections", {})).some(item => item.toLowerCase() === name.toLowerCase())) {
        throw Object.assign(new Error("A remote team connection with the same name already exists"), { status: 409 });
      }
      if (existing && existing !== name) throw Object.assign(new Error("Team directory name case conflict"), { status: 409 });
      const target = resolve(agentsDirectory, name);
      const previous = existing ? await readFiles(name) : undefined;
      if (previous && !force) {
        const recordPath = resolve(target, installRecord);
        const info = await lstat(recordPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        let saved: unknown;
        if (info?.isFile() && info.size < 4096) {
          try { saved = JSON.parse(await readFile(recordPath, "utf8")).fingerprint; } catch { /* Without a valid install fingerprint, local content cannot be confirmed unmodified. */ }
        }
        if (saved !== fingerprint(previous.files)) {
          throw Object.assign(new Error("This team has local changes or no installation record. Export a backup first. If you are sure you want to overwrite it, use Force Install in developer settings."), { status: 409 });
        }
        let version: unknown;
        try { version = JSON.parse(decodeText(previous.files.get("team.json")!)).version; } catch { /* A missing version is reported by the shared upgrade check. */ }
        requireNewerVersion(version, manifest.version, `Team "${name}"`);
      }
      temporary = await mkdtemp(resolve(root, ".agentInstall"));
      const staged = resolve(temporary, "new");
      for (const [path, content] of files) {
        const destination = resolve(staged, path);
        if (!isWithin(staged, destination)) throw Object.assign(new Error("Invalid team file path"), { status: 400 });
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, { flag: "wx", mode: 0o600 });
      }
      await writeFile(resolve(staged, installRecord), JSON.stringify({ fingerprint: fingerprint(files) }), { flag: "wx", mode: 0o600 });
      const backup = resolve(temporary, "previous");
      if (previous) await rename(target, backup);
      try { await rename(staged, target); }
      catch (error) {
        if (previous) {
          try { await rename(backup, target); }
          catch (restoreError) {
            preserveBackup = true;
            throw new AggregateError([error, restoreError], `Team update failed; the old version is kept in ${backup}. Restore it and try again`);
          }
        }
        throw error;
      }
      const actualTarget = await realpath(target);
      for (const path of [...(previous?.files.keys() ?? []), ...files.keys()]) {
        if (path.startsWith("tools/")) delete require.cache[resolve(actualTarget, path)];
      }
      return { name };
    } finally {
      if (temporary && !preserveBackup && temporary !== root && isWithin(root, temporary)) {
        await rm(temporary, { recursive: true, force: true }).catch(error => console.warn(`Failed to clean up the team installation staging directory: ${temporary}`, error));
      }
    }
  });
}
