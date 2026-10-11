import { createHash } from "node:crypto";
import { t } from "@/lib/i18n";
import { lookup } from "node:dns/promises";
import { request, type ClientRequest, type IncomingMessage } from "node:http";
import { request as requestSecure } from "node:https";
import { BlockList, isIP } from "node:net";
import { mkdir, realpath, stat } from "@toonflow/file";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

const maxImageSize = 20 * 1024 * 1024;
const imageFormats = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp" };
const inflight = new Map<string, Promise<{ path: string; mimeType: string }>>();
const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) privateAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) privateAddresses.addSubnet(address, prefix, "ipv6");
const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !privateAddresses.check(address, "ipv4")
    : family === 6 && publicIpv6.check(address, "ipv6") && !privateAddresses.check(address, "ipv6");
}

function remoteAddress(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return invalid("Invalid image URL. Use a complete HTTP/HTTPS URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalid("Images only support HTTP/HTTPS URLs without usernames or passwords");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) invalid("Images cannot be downloaded from local, private, or special-use network addresses", 403);
  url.hash = "";
  return url;
}

function requestImage(url: URL, signal: AbortSignal) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    const abort = () => { outgoing?.destroy(); incoming?.destroy(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void (async () => {
      signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) invalid("Images cannot be downloaded from addresses that resolve to local, private, or special-use networks", 403);
      const address = addresses[0];
      const connection = new URL(url);
      connection.hostname = address.family === 6 ? `[${address.address}]` : address.address;
      // ACT: Pin the validated IP while keeping the original Host and TLS certificate
      // name; Bun's request signal may not end promptly, so destroy and reject explicitly.
      outgoing = (url.protocol === "https:" ? requestSecure : request)(connection, {
        method: "GET", agent: false, servername: hostname,
        headers: { Host: url.host, Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/bmp" },
      }, response => {
        incoming = response;
        response.once("close", cleanup);
        if (signal.aborted) { abort(); return; }
        resolve(response);
      });
      outgoing.once("error", error => { cleanup(); reject(error); });
      if (signal.aborted) abort();
      else outgoing.end();
    })().catch(error => { cleanup(); reject(error); });
  });
}

function imageMimeType(bytes: Buffer): keyof typeof imageFormats {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return "image/png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 13 && /^GIF8[79]a/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && /^VP8[ LX]$/.test(bytes.toString("ascii", 12, 16))) return "image/webp";
  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (bytes.length >= 16 && bytes.toString("ascii", 4, 8) === "ftyp") {
    const end = bytes.readUInt32BE(0);
    if (end >= 16 && end <= bytes.length) {
      for (let offset = 8; offset + 4 <= end; offset += 4) if (["avif", "avis"].includes(bytes.toString("ascii", offset, offset + 4))) return "image/avif";
    }
  }
  if (/<svg(?:\s|>)/i.test(bytes.toString("utf8", 0, 512))) invalid("Remote SVG images are not yet supported. Use PNG, JPEG, WebP, GIF, AVIF, or BMP.");
  return invalid("The downloaded content is not a supported image. A webpage or sign-in page may have been returned.");
}

async function downloadImage(url: URL, signal: AbortSignal) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    const response = await requestImage(url, signal);
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects === 5) invalid("Image redirects are invalid or exceed 5. Use a direct image URL.", 502);
      url = remoteAddress(new URL(location, url).href);
      continue;
    }
    if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      invalid(t`Image download failed (HTTP ${response.statusCode ?? 0}). The link may have expired or require sign-in.`, 502);
    }
    if (Number(response.headers["content-length"]) > maxImageSize) { response.destroy(); invalid("Chat images must not exceed 20 MB", 413); }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxImageSize) { response.destroy(); invalid("Chat images must not exceed 20 MB", 413); }
      chunks.push(bytes);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    return { bytes, mimeType: imageMimeType(bytes) };
  }
  return invalid("Invalid image redirect", 502);
}

export async function importImage(cwd: string, value: string) {
  const directory = await realpath(cwd);
  const url = remoteAddress(value);
  const key = JSON.stringify([directory, url.href]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const hash = createHash("sha256").update(url.href).digest("hex");
    const outputDirectory = "assets/chatImages";
    for (const [mimeType, extension] of Object.entries(imageFormats)) {
      const path = `${outputDirectory}/${hash}.${extension}`;
      const cached = await resolveWorkspacePath(directory, path, true);
      const info = await stat(cached.path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (info?.isFile() && info.size > 0 && info.size <= maxImageSize) return { path, mimeType };
    }
    const signal = AbortSignal.timeout(30000);
    const { bytes, mimeType } = await downloadImage(url, signal).catch(error => {
      if (signal.aborted) invalid("Image download timed out (30 seconds). Check the network and try again.", 504);
      if (error instanceof Error && "status" in error) throw error;
      throw Object.assign(new Error("Failed to connect for image download. Check the image URL, network, or HTTPS certificate.", { cause: error }), { status: 502 });
    });
    const path = `${outputDirectory}/${hash}.${imageFormats[mimeType]}`;
    const output = await resolveWorkspacePath(directory, outputDirectory, true);
    const candidate = await resolveWorkspacePath(directory, path, true);
    const release = lockWorkspaceFiles([candidate.path]);
    try {
      await mkdir(output.path, { recursive: true });
      const target = await resolveWorkspacePath(directory, path);
      await writeWorkspaceFile(target.path, bytes, true);
    } finally { release(); }
    return { path, mimeType };
  })();
  inflight.set(key, pending);
  try { return await pending; }
  finally { if (inflight.get(key) === pending) inflight.delete(key); }
}
