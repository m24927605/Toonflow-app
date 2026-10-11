import { t, translateMessage } from "@/lib/i18n";
import { mkdir, mkdtemp, lstat, readFile, readdir, rename, rm, unlink, writeFile } from "@toonflow/file";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { crc32, inflateRawSync } from "node:zlib";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import conf from "@/utils/conf";
import { parseTool, toolsDirectory } from "@/utils/plugins/tools";
import { extDirectory, parseExt } from "@/utils/plugins/ext";
import { isSafeSegment } from "@/utils/skills/files";
import { isWithin, lockWorkspaceFiles, writeWorkspaceFile } from "@/utils/workspace/files";

const maxBytes = 20 * 1024 * 1024;
const require = createRequire(import.meta.url);

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

export function requireNewerVersion(current: unknown, incoming: unknown, label: string) {
  // ACT: Bun's comparator accepts loose versions; require full SemVer
  // first and do not guess update order when a version is missing.
  const versions = [current, incoming].map(value => {
    if (typeof value !== "string" || value.length > 256) return;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
    if (!match || !match.slice(1, 4).every(part => Number.isSafeInteger(Number(part)))
      || match[4]?.split(".").some(part => /^\d+$/.test(part) && (!/^(0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part))))) return;
    return match[0];
  });
  const [installed, next] = versions;
  if (!installed || !next) invalid(t`${label} has been installed, but the existing or to-be-installed version is missing or invalid, and the update sequence cannot be determined; please use forced installation in developer settings`, 409);
  if (Bun.semver.order(next, installed) <= 0) invalid(t`${label} version ${installed} is installed; version ${next} is not newer. To overwrite or downgrade, use Force Install in developer settings`, 409);
}

function nodeVersion(source: string) {
  try { return JSON.parse(source.match(/^\/\*! toonflowNode:([^\r\n]*) \*\/(?:\r?\n|$)/)?.[1] ?? "").version; }
  catch { return undefined; }
}

function remoteAddress(value: string) {
  let address: URL;
  try { address = new URL(value); }
  catch { return invalid("The download address format is invalid, please provide the complete HTTP / HTTPS file address"); }
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password) {
    invalid("Only HTTP / HTTPS URLs without a username or password are supported");
  }
  return address;
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number, message: string) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) invalid(message, 413);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

async function download(url: string, limit: number, label: string) {
  label = translateMessage(label);
  let address = remoteAddress(url);
  const signal = AbortSignal.timeout(30_000);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(address, { signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) invalid(t`${label} Download failed: Server redirect response is missing Location address`, 502);
        if (redirects === 5) invalid(t`${label} Download failed: redirected more than 5 times, please use the direct download address of the file`, 502);
        try { address = remoteAddress(new URL(location, address).href); }
        catch { invalid(t`${label} Download failed: Redirect target is not a valid HTTP/HTTPS address`, 502); }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401 || response.status === 403
          ? "The download was rejected. The link may have expired, the signature is invalid, or there is no access permission. Please regenerate the download link."
          : response.status === 404 ? "The file does not exist, please confirm the upload path and file name; you need to regenerate the download link after changing the name."
          : response.status === 410 ? "The file has expired, please get a new download link."
          : response.status === 429 ? "Download requests are too frequent, please try again later."
          : response.status >= 500 ? "The download server is temporarily abnormal, please try again later."
          : "The server did not return the file, please check the download address";
        invalid(t`${label} download failed (HTTP ${response.status}): ${translateMessage(hint)}`, 502);
      }
      if (!response.body) invalid(t`${label} Download failed: The server did not return the file content`, 502);
      const bytes = await readBounded(response.body, limit, t`${label} file cannot exceed ${limit / 1024 / 1024} MB`);
      if (!bytes.byteLength) invalid(t`${label} Download failed: The file content is empty, please re-upload the file`, 502);
      return bytes;
    }
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    if (signal.aborted) invalid(t`${label} Download timeout (30 seconds), please check the network or obtain the download link again`, 504);
    invalid(t`${label} Download connection failed, please check the network, download domain name and HTTPS certificate and try again`, 502);
  }
  return invalid("The download address is invalid");
}

export function decodeText(bytes: Uint8Array) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return invalid("The plugin text content is not a valid UTF-8 encoding. Please check the file encoding and re-upload it."); }
}

export async function installNode(fileName: string, source: string, force = false) {
  if (!/^[a-z][a-zA-Z0-9]*\.umd\.js$/.test(fileName)) invalid("The file name needs to be in lowerCamelCase format, such as imageNode.umd.js");
  if (!source.trim()) invalid("The node file content is empty, please re-upload the node script.");
  if (Buffer.byteLength(source, "utf8") > maxBytes) invalid("Node file cannot exceed 20 MB", 413);
  const name = fileName.slice(0, -7);
  if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(source)) {
    invalid("The node file is actually an HTML web page, not a node script. Please re-upload the .umd.js file generated by the build.");
  }
  // ACT: Only statically check scaffold conventions and syntax; the canvas loads and runs it after the install is confirmed.
  if (!source.includes("toonflowNodeHost")) invalid("file is not compatible with Toonflow node, please use node scaffolding to build the generated .umd.js file");
  if (!source.includes(`toonflowNodes.${name}`)) invalid(t`The file name is inconsistent with the node export name: ${fileName} needs to export toonflowNodes.${name}, please modify the file name according to the actual node name.`);
  try { new Bun.Transpiler({ loader: "js" }).scan(source); }
  catch { invalid("Invalid node script syntax, please rebuild and upload the complete .umd.js file"); }
  const directory = resolve(dirname(conf.path), "nodes");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) invalid("Node directory cannot be a symbolic link", 403);
  const path = resolve(directory, fileName);
  const release = lockWorkspaceFiles([path]);
  try {
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (current && !current.isFile()) invalid("The existing node must be a normal file", 403);
    if (current && !force) requireNewerVersion(current.size <= maxBytes ? nodeVersion(await readFile(path, "utf8")) : undefined, nodeVersion(source), `Node "${name}"`);
    await writeWorkspaceFile(path, source, !current);
  } finally { release(); }
  return { name };
}

export async function installExt(fileName: string, source: string, force = false) {
  if (!/^ext-[a-z][a-zA-Z0-9]*\.umd\.js$/.test(fileName)) invalid("The file name must use ext- followed by a lowerCamelCase name, such as ext-image.umd.js");
  if (!source.trim()) invalid("The file extension is empty. Please upload the extension script again");
  if (Buffer.byteLength(source, "utf8") > maxBytes) invalid("File extensions cannot exceed 20 MB", 413);
  const name = fileName.slice(0, -7);
  const metadata = parseExt(source, name);
  if (!source.includes("toonflowExtHost") || !new RegExp(`toonflowExts\\s*\\[\\s*["']${name}["']\\s*\\]`).test(source)) {
    invalid("This file is not a compatible Toonflow file extension. Build it using the extension scaffold and retain the original file name");
  }
  try { new Bun.Transpiler({ loader: "js" }).scan(source); }
  catch { invalid("The file extension script has invalid syntax. Please rebuild the complete .umd.js file"); }
  await mkdir(extDirectory, { recursive: true });
  if ((await lstat(extDirectory)).isSymbolicLink()) invalid("The file extension directory cannot be a symbolic link", 403);
  const path = resolve(extDirectory, fileName);
  const release = lockWorkspaceFiles([path]);
  try {
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (current && !current.isFile()) invalid("The existing file extension must be a regular file", 403);
    if (current && !force) {
      let version: string | undefined;
      try { if (current.size <= maxBytes) version = parseExt(await readFile(path, "utf8"), name).version; }
      catch { /* A corrupt installed version can only be overwritten by an explicit forced install. */ }
      requireNewerVersion(version, metadata.version, `File extension "${name}"`);
    }
    await writeWorkspaceFile(path, source, !current);
    await unlink(resolve(extDirectory, `${name}.removed`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  } finally { release(); }
  return { name };
}

export async function installTool(fileName: string, source: string, force = false) {
  if (!/^[a-z][a-zA-Z0-9]*\.tool\.js$/.test(fileName)) invalid("The tool file name is invalid, please choose the .tool.js file named in lowerCamelCase.");
  if (!source.trim()) invalid("The tool file content is empty, please re-upload the tool script.");
  if (Buffer.byteLength(source, "utf8") > maxBytes) invalid("Tool file cannot exceed 20 MB", 413);
  const name = fileName.slice(0, -8);
  const { metadata } = parseTool(source, name);
  try {
    if (!new Bun.Transpiler({ loader: "js" }).scan(source).exports.includes("default")) throw new Error("default");
  } catch { invalid("Tool script syntax is invalid or default export is missing"); }
  await mkdir(toolsDirectory, { recursive: true });
  if ((await lstat(toolsDirectory)).isSymbolicLink()) invalid("The tools directory cannot be a symbolic link", 403);
  const path = resolve(toolsDirectory, fileName);
  const release = lockWorkspaceFiles([path]);
  try {
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (current && !current.isFile()) invalid("Existing tools must be ordinary files", 403);
    if (current && !force) {
      let version: unknown;
      if (current.size <= maxBytes) {
        const previous = await readFile(path, "utf8");
        try { version = parseTool(previous, name).metadata.version; } catch { /* Corrupt metadata has no comparable version. */ }
      }
      requireNewerVersion(version, metadata.version, `Tool "${name}"`);
    }
    await writeWorkspaceFile(path, source, !current);
    // ACT: Bun caches modules by file path, so a URL query does not invalidate an already loaded tool.
    delete require.cache[path];
  } finally { release(); }
  return { name };
}

export function skillPath(value: string, directory = false) {
  let path = value.replace(/^(\.\/)+/, "");
  if (directory) path = path.replace(/\/$/, "");
  if (!path && directory) return "";
  if (!path || path.length > 1024 || path.split("/").some(part => !isSafeSegment(part))) invalid("Skill pack contains an unsafe file path");
  return path;
}

function skillEntryPaths() {
  const entries = new Set<string>();
  const paths = new Map<string, { path: string; directory: boolean }>();
  return (original: string, directory: boolean) => {
    const path = skillPath(original, directory);
    if (entries.has(path.toLowerCase())) invalid("The skill package contains files or directories with duplicate names.");
    entries.add(path.toLowerCase());
    if (entries.size > 2000) invalid("Skill package contains up to 2000 files and directories");
    const parts = path ? path.split("/") : [];
    for (let index = 1; index <= parts.length; index++) {
      const nested = parts.slice(0, index).join("/");
      const isDirectory = index < parts.length || directory;
      const existing = paths.get(nested.toLowerCase());
      if (existing && (existing.path !== nested || existing.directory !== isDirectory)) invalid("Skill pack contains conflicting file or directory paths");
      paths.set(nested.toLowerCase(), { path: nested, directory: isDirectory });
    }
    return path;
  };
}

export function skillZip(bytes: Uint8Array) {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = data.length - 22;
  for (; end >= Math.max(0, data.length - 65557); end--) {
    if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length) break;
  }
  if (end < Math.max(0, data.length - 65557)) invalid("Invalid end of ZIP skill package");
  const count = data.readUInt16LE(end + 10);
  const start = data.readUInt32LE(end + 16);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== count
    || count === 0xffff || start + data.readUInt32LE(end + 12) !== end) invalid("Please use the ordinary ZIP skill package that is not divided into volumes. ZIP64 is not supported.");
  if (count > 2000) invalid("Skill package contains up to 2000 files and directories");
  const entryPath = skillEntryPaths();
  const entries: { path: string; directory: boolean; size: number; checksum: number; method: number; start: number; end: number; header: number }[] = [];
  let total = 0;
  let offset = start;
  // ACT: Only stored/Deflate ZIPs are supported; validate the directory and declared
  // sizes first, then extract within limits instead of unpacking straight to disk.
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) invalid("ZIP skill package directory is invalid");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const checksum = data.readUInt32LE(offset + 16);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const next = offset + 46 + nameLength + extraLength + data.readUInt16LE(offset + 32);
    const header = data.readUInt32LE(offset + 42);
    if (next > end || header + 30 > start || data.readUInt16LE(offset + 34)) invalid("ZIP skill package file header is invalid");
    if (flags & ~0x080e || ![0, 8].includes(method)) invalid("ZIP skill package cannot be encrypted and only supports storage or Deflate compression.");
    const original = decodeText(data.subarray(offset + 46, offset + 46 + nameLength));
    const attributes = data.readUInt32LE(offset + 38);
    const kind = (attributes >>> 16) & 0xf000;
    const directory = original.endsWith("/") || Boolean(attributes & 0x10) || kind === 0x4000;
    if (![0, 0x4000, 0x8000].includes(kind)) invalid("ZIP skill pack cannot contain links, devices, or other special files");
    const path = entryPath(original, directory);
    total += size;
    if (size === 0xffffffff || compressed === 0xffffffff || total > maxBytes) invalid("The skill package cannot exceed 20 MB after decompression.", 413);
    if (directory && size !== 0 || method === 0 && compressed !== size) invalid("ZIP skill pack file size is invalid");
    if (data.readUInt32LE(header) !== 0x04034b50 || data.readUInt16LE(header + 6) !== flags
      || data.readUInt16LE(header + 8) !== method || data.readUInt16LE(header + 26) !== nameLength) invalid("ZIP skill package entries are inconsistent");
    const content = header + 30 + nameLength + data.readUInt16LE(header + 28);
    if (content + compressed > start || !data.subarray(header + 30, header + 30 + nameLength).equals(data.subarray(offset + 46, offset + 46 + nameLength))) invalid("ZIP skill package entries are inconsistent");
    if (!(flags & 8) && (data.readUInt32LE(header + 14) !== checksum || data.readUInt32LE(header + 18) !== compressed
      || data.readUInt32LE(header + 22) !== size)) invalid("ZIP skill package entry size or check value is inconsistent");
    entries.push({ path, directory, size, checksum, method, start: content, end: content + compressed, header });
    offset = next;
  }
  if (offset !== end) invalid("ZIP skill package directory length is inconsistent");
  entries.sort((first, second) => first.header - second.header);
  const result = new Map<string, Uint8Array>();
  let previousEnd = 0;
  for (const entry of entries) {
    if (entry.header < previousEnd) invalid("ZIP skills package contains overlapping entries");
    previousEnd = entry.end;
    let content: Uint8Array;
    try {
      const compressed = data.subarray(entry.start, entry.end);
      content = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
    } catch { return invalid("The ZIP skill package is damaged or the actual decompressed size exceeds the declared value"); }
    if (content.byteLength !== entry.size || crc32(content) !== entry.checksum) invalid("ZIP skill package file size or check value error");
    if (!entry.directory && !entry.path.startsWith("__MACOSX/") && entry.path.split("/").at(-1) !== ".DS_Store") result.set(entry.path, content);
  }
  return result;
}

async function skillArchive(bytes: Uint8Array) {
  let tar = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      tar = await readBounded(new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("gzip")), maxBytes, "The skill package cannot exceed 20 MB after decompression.");
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      invalid("The skill compressed package is damaged");
    }
  }
  if (tar.length > maxBytes || tar.length % 512 !== 0) invalid("The skill compressed package is invalid or exceeds 20 MB after decompression.");
  const entries = new Map<string, { size: number; directory: boolean }>();
  const entryPath = skillEntryPaths();
  function field(header: Uint8Array, start: number, length: number) {
    const data = header.subarray(start, start + length);
    return decodeText(data.subarray(0, data.indexOf(0) < 0 ? data.length : data.indexOf(0)));
  }
  // ACT: Bun.Archive.files() skips links and merges duplicate names; check
  // plain USTAR headers first and reject complex PAX/GNU extensions.
  for (let offset = 0; offset < tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) invalid("Skill pack contains additional data at the end");
      break;
    }
    const checksum = field(header, 148, 8).trim();
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    const sizeField = field(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(checksum) || Number.parseInt(checksum, 8) !== sum || !/^[0-7]+$/.test(sizeField)) invalid("The skill package file header is invalid");
    const size = Number.parseInt(sizeField, 8);
    const directory = header[156] === 53;
    if (![0, 48, 53].includes(header[156]!)) invalid("Skill pack cannot contain link, device or PAX/GNU extension entries, please use plain tar format");
    if (directory && size !== 0 || offset + 512 + Math.ceil(size / 512) * 512 > tar.length) invalid("The skill pack file size is invalid.");
    const prefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
    const original = [prefix, field(header, 0, 100)].filter(Boolean).join("/");
    const path = entryPath(original, directory);
    entries.set(path.toLowerCase(), { size, directory });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  let files: Map<string, File>;
  try { files = await new Bun.Archive(tar).files(); }
  catch { return invalid("The skill compressed package cannot be read."); }
  const result = new Map<string, Uint8Array>();
  for (const [original, file] of files) {
    const path = skillPath(original);
    const entry = entries.get(path.toLowerCase());
    if (!entry || entry.directory || entry.size !== file.size || result.has(path)) invalid("Skill package entries are inconsistent");
    result.set(path, new Uint8Array(await file.arrayBuffer()));
  }
  if (result.size !== [...entries.values()].filter(entry => !entry.directory).length) invalid("The skill package entry is incomplete");
  return result;
}

export async function installSkill(fileName: string, bytes: Uint8Array, force = false) {
  if (!fileName || fileName.length > 128 || /[\\/]/.test(fileName) || !/\.(md|zip|tar|tar\.gz|tgz)$/i.test(fileName)) invalid("Please select a .zip, .md, .tar, .tar.gz or .tgz skill file");
  skillPath(fileName);
  if (!bytes.byteLength) invalid("Skill file cannot be empty");
  if (bytes.byteLength > maxBytes) invalid("Skill file cannot exceed 20 MB", 413);
  const files = /\.md$/i.test(fileName) ? new Map([["SKILL.md", bytes]]) : /\.zip$/i.test(fileName) ? skillZip(bytes) : await skillArchive(bytes);
  const manifests = [...files.keys()].filter(path => path === "SKILL.md" || path.endsWith("/SKILL.md"));
  if (manifests.length !== 1) invalid("The skill package must contain one and only one SKILL.md");
  const manifest = manifests[0]!;
  const prefix = manifest.slice(0, -8);
  if ([...files.keys()].some(path => !path.startsWith(prefix))) invalid("Skill resources must be located in the directory where SKILL.md is located");
  let frontmatter: Record<string, unknown>;
  try { ({ frontmatter } = parseFrontmatter(decodeText(files.get(manifest)!))); }
  catch { return invalid("Invalid SKILL.md frontmatter"); }
  const name = frontmatter?.name;
  const description = frontmatter?.description;
  // ACT: Accept both locally created lowerCamelCase names and existing
  // kebab-case names without changing in-package identifiers.
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*$/.test(name)) invalid("Skill name must be at most 64 characters in lowerCamelCase or kebab-case");
  skillPath(name);
  if (typeof description !== "string" || !description.trim() || description.length > 1024) invalid("Skill description must be 1 to 1024 characters");
  const root = dirname(conf.path);
  const directory = join(root, "skills");
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink()) invalid("The skills directory cannot be a symbolic link", 403);
  const target = join(directory, name);
  const release = lockWorkspaceFiles([directory]);
  let temporary: string | undefined;
  let preserveBackup = false;
  try {
    const existing = (await readdir(directory)).find(item => item.toLowerCase() === name.toLowerCase());
    if (existing && existing !== name) invalid(t`The skill directory "${existing}" and "${name}" have a case conflict. Please unify the names first.`, 409);
    if (existing) {
      if (!(await lstat(target)).isDirectory()) invalid("Existing skills must be in separate normal directories", 403);
      const current = await lstat(join(target, "SKILL.md"));
      if (!current.isFile()) invalid("The existing skill master file must be a normal file", 403);
      const entries = await readdir(target, { recursive: true, withFileTypes: true });
      if (entries.some(entry => entry.name.toLowerCase() === "skill.md" && join(entry.parentPath, entry.name) !== join(target, "SKILL.md"))) invalid("The directory contains other skills and cannot be replaced as a whole.", 409);
      if (!force) {
        let version: unknown;
        if (current.size <= maxBytes) {
          const previous = await readFile(join(target, "SKILL.md"), "utf8");
          try { version = (parseFrontmatter(previous).frontmatter.metadata as Record<string, unknown> | undefined)?.version; } catch { /* Corrupt metadata has no comparable version. */ }
        }
        requireNewerVersion(version, (frontmatter.metadata as Record<string, unknown> | undefined)?.version, `Skill "${name}"`);
      }
    }
    temporary = await mkdtemp(join(root, ".skillInstall"));
    if (!isWithin(root, temporary)) invalid("The skill temporary storage directory is invalid.");
    const staged = join(temporary, "new");
    for (const [path, content] of files) {
      const destination = resolve(staged, path.slice(prefix.length));
      if (!isWithin(staged, destination)) invalid("The skill resource path is invalid");
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    }
    // ACT: Swap the whole directory under the single-process lock; the old
    // version stays until the new one is in place and is restored on failure.
    const backup = join(temporary, "previous");
    if (existing) await rename(target, backup);
    try { await rename(staged, target); }
    catch (error) {
      if (existing) {
        try { await rename(backup, target); }
        catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError([error, restoreError], `Skill update failed; the old version is kept in ${backup}. Restore it and try again`);
        }
      }
      throw error;
    }
    return { name };
  } finally {
    try {
      if (temporary && !preserveBackup && temporary !== root && isWithin(root, temporary)) {
        await rm(temporary, { recursive: true, force: true }).catch(error => console.warn(`Failed to clean up the skill installation staging directory: ${temporary}`, error));
      }
    } finally { release(); }
  }
}

export async function installRemotePlugin(type: "node" | "tool" | "skill" | "agent" | "ext", url: string, fileName?: string, force = false) {
  const address = remoteAddress(url);
  if (fileName === undefined) {
    try { fileName = decodeURIComponent(address.pathname.split("/").at(-1) ?? ""); }
    catch { return invalid("The file name encoding in the download address is invalid, please regenerate the download link."); }
  }
  const patterns = { node: /^[a-z][a-zA-Z0-9]*\.umd\.js$/, ext: /^ext-[a-z][a-zA-Z0-9]*\.umd\.js$/, tool: /^[a-z][a-zA-Z0-9]*\.tool\.js$/, skill: /\.(md|zip|tar|tar\.gz|tgz)$/i, agent: /^[a-z][a-zA-Z0-9]*\.agent\.zip$/ };
  const examples = { node: "audioNode.umd.js", ext: "ext-image.umd.js", tool: "exampleTool.tool.js", skill: "example.zip, SKILL.md, example.tar, example.tar.gz or example.tgz", agent: "exampleTeam.agent.zip" };
  if (!Object.hasOwn(patterns, type)) invalid("Unsupported plugin type. Valid values: node, ext, tool, skill, agent");
  if (!fileName) invalid(t`The download address is missing a file name, please use an address pointing to the file, for example ${examples[type]}`);
  if (fileName.length > 128 || /[\\/]/.test(fileName)) invalid("The plugin file name is invalid and cannot contain a directory path or exceed 128 characters.");
  if (!patterns[type].test(fileName)) invalid(t`The download file name "${fileName.slice(0, 128)}" does not comply with the ${type} type specification. Example of file name: ${examples[type]}; please regenerate the download link after changing the name.`);
  const bytes = await download(url, maxBytes, { node: "Node", ext: "File Extensions", tool: "Tools", skill: "Skills", agent: "Team" }[type]);
  if (type === "agent") return (await import("@/utils/teams/install")).installTeam(fileName, bytes, force);
  if (type === "skill") return installSkill(fileName, bytes, force);
  const source = decodeText(bytes);
  if (type === "node") return installNode(fileName, source, force);
  if (type === "ext") return installExt(fileName, source, force);
  return installTool(fileName, source, force);
}
