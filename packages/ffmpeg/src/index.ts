import { msg } from "@toonflow/i18n";
import { messageError } from "@toonflow/i18n/errors";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, chmod, lstat, mkdir, mkdtemp, realpath, rename, rm } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { builds, downloadUrl } from "./catalog";

export { createFfmpeg } from "./runtime";
export { executeRemoteFfmpeg } from "./remote";
export type { BrowserFfmpegRequest } from "./browserTypes";
export type * from "./types";
export type FfmpegMode = "auto" | "download" | "system";
export type DownloadState = {
  phase: "idle" | "downloading" | "verifying" | "installing" | "completed" | "error" | "cancelled";
  file?: string;
  received: number;
  total?: number;
  error?: string;
};

export const target = `${process.platform}-${process.arch}`;
export const build = Object.hasOwn(builds, target) ? builds[target as keyof typeof builds] : undefined;
const toolNames = ["ffmpeg", "ffprobe"] as const;

function executableName(name: string) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function readVersion(path: string, name: string, signal?: AbortSignal) {
  const child = Bun.spawn([path, "-version"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: 15000, signal,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")),
  });
  const [output, code] = await Promise.all([child.stdout.text(), child.exited]);
  signal?.throwIfAborted();
  const version = output.split(/\r?\n/, 1)[0];
  if (code !== 0 || !version?.startsWith(`${name} version `)) throw messageError(msg`${name} cannot run, please check platform compatibility or download again`);
  return version;
}

export async function getToolStatus(directory: string, mode: FfmpegMode, formatError = (error: unknown) => error instanceof Error ? error.message : String(error)) {
  const entries = await Promise.all(toolNames.map(async (name) => {
    const downloaded = join(directory, executableName(name));
    const hasDownload = mode !== "system" && await file(downloaded).exists();
    const path = hasDownload ? downloaded : mode === "download" ? null : Bun.which(executableName(name));
    const origin = path ? hasDownload ? "download" as const : "system" as const : null;
    try {
      return [name, { path, origin, version: path ? await readVersion(path, name) : null, error: path ? null : "No available program found" }] as const;
    } catch (error) {
      return [name, { path, origin, version: null, error: formatError(error) }] as const;
    }
  }));
  return Object.fromEntries(entries) as Record<typeof toolNames[number], typeof entries[number][1]>;
}

async function checkDirectory(path: string) {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw messageError(msg`The installation directory must be a normal folder: ${path}`);
  return stat !== null;
}

export async function installFfmpeg(directory: string, signal: AbortSignal, report: (state: DownloadState) => void) {
  if (!build) throw messageError(msg`does not currently support automatic download of ${target} version`);
  signal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
  signal.throwIfAborted();
  const parent = dirname(resolve(directory));
  await checkDirectory(parent);
  await mkdir(parent, { recursive: true });
  const root = await realpath(parent);
  const destination = join(root, basename(directory));
  await checkDirectory(destination);
  const temporary = await mkdtemp(join(root, ".install-"));
  const staged = join(temporary, "bin");
  const previous = join(temporary, "previous");
  let preserveBackup = false;
  try {
    await mkdir(staged);
    for (const name of toolNames) {
      signal.throwIfAborted();
      const asset = build[name];
      report({ phase: "downloading", file: name, received: 0 });
      const response = await fetch(`${downloadUrl}${asset.fileName}`, { signal });
      if (!response.ok || !response.body) throw messageError(msg`${name} Download failed (HTTP ${response.status})`);
      const total = Number(response.headers.get("content-length")) || undefined;
      let received = 0;
      const hash = createHash("sha256");
      const compressed = join(temporary, asset.fileName);
      await pipeline(Readable.from(response.body), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > 128 * 1024 * 1024) return callback(new Error("Download file exceeds allowed size"));
          hash.update(chunk);
          report({ phase: "downloading", file: name, received, total });
          callback(null, chunk);
        },
      }), createWriteStream(compressed, { flags: "wx", signal }), { signal });
      report({ phase: "verifying", file: name, received, total });
      if (hash.digest("hex") !== asset.sha256) throw messageError(msg`${name} File verification failed, please try again.`);
      const binary = join(staged, executableName(name));
      let extracted = 0;
      await pipeline(createReadStream(compressed, { signal }), createGunzip(), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          extracted += chunk.length;
          callback(extracted > 256 * 1024 * 1024 ? new Error("The decompressed file exceeds the allowed size") : null, chunk);
        },
      }), createWriteStream(binary, { flags: "wx", signal }), { signal });
      if (process.platform !== "win32") await chmod(binary, 0o755);
      await readVersion(binary, name, signal);
    }
    signal.throwIfAborted();
    // ACT: Replace both binaries together only after both are verified;
    // ignore cancellation once the commit starts to avoid leaving a half-installed set.
    report({ phase: "installing", received: 0 });
    const existed = await checkDirectory(destination);
    if (existed) await rename(destination, previous);
    try {
      await rename(staged, destination);
    } catch (error) {
      if (existed) {
        try { await rename(previous, destination); }
        catch {
          preserveBackup = true;
          throw messageError(msg`Installation failed and old version cannot be restored, old files remain in ${previous}`, { cause: error });
        }
      }
      throw error;
    }
  } finally {
    // Only clean up the temp directory created by this mkdtemp call that is still inside the data directory.
    if (!preserveBackup && dirname(temporary) === root) {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => {
        console.warn(`Failed to clean up FFmpeg temporary directory: ${temporary}`, error);
      });
    }
  }
}
