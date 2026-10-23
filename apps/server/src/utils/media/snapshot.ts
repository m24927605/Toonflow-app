import { createHash } from "node:crypto";
import { z } from "zod";
import { mkdir, writeAtomic } from "@toonflow/file";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { mediaExtensions, readReference } from "./generation";

export const snapshotRequestSchema = z.strictObject({
  files: z.array(z.strictObject({ path: z.string().min(1).max(2048), mimeType: z.string().regex(/^(image|audio|video)\/[a-z0-9.+-]+$/i) })).max(20),
  outputDirectory: z.string().min(1).max(2048), binding: z.json().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 1024 * 1024, "Snapshot bindings exceed 1 MiB"),
});
export const inputSnapshotSchema = z.strictObject({
  request: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.strictObject({ source: z.string().min(1), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
}).refine(snapshot => new Set(snapshot.files.map(file => file.source)).size === snapshot.files.length && snapshot.fingerprint === createHash("sha256").update(JSON.stringify({ request: snapshot.request, files: snapshot.files.map(({ source, sha256 }) => ({ source, sha256 })) })).digest("hex"), "Input snapshot identity does not match its manifest");

/** Freeze exact media bytes; this performs no semantic or model-based review. */
export async function snapshotMedia(cwd: string, input: z.infer<typeof snapshotRequestSchema>, signal: AbortSignal) {
  const request = snapshotRequestSchema.parse(input);
  await resolveWorkspacePath(cwd, request.outputDirectory, true);
  const sources = new Map<string, string>();
  for (const file of request.files) {
    const mimeType = file.mimeType.toLowerCase();
    if (sources.has(file.path) && sources.get(file.path) !== mimeType) throw new Error("A snapshot source has conflicting media types");
    sources.set(file.path, mimeType);
  }
  const inputs: { source: string; bytes: Uint8Array; extension: string; sha256: string }[] = [];
  let totalBytes = 0;
  for (const [source, mimeType] of sources) {
    signal.throwIfAborted();
    const reference = await readReference(cwd, { path: source, mimeType }, mimeType.split("/")[0]!, signal);
    const extension = mediaExtensions[reference.mimeType];
    if (!extension) throw new Error("Snapshot media type is unsupported");
    const bytes = Buffer.from(reference.data, "base64");
    totalBytes += bytes.length;
    if (totalBytes > 100 * 1024 * 1024) throw new Error("Input snapshots exceed 100 MiB");
    inputs.push({ source, bytes, extension, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const binding = createHash("sha256").update(JSON.stringify(request.binding)).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify({ request: binding, files: inputs.map(({ source, sha256 }) => ({ source, sha256 })) })).digest("hex");
  const directory = `${request.outputDirectory}/${fingerprint}`;
  await mkdir((await resolveWorkspacePath(cwd, directory, true)).path, { recursive: true });
  const files = await Promise.all(inputs.map(async (input, index) => {
    signal.throwIfAborted();
    const path = `${directory}/input${index}.${input.extension}`;
    await writeAtomic((await resolveWorkspacePath(cwd, path, true)).path, input.bytes);
    return { source: input.source, path, sha256: input.sha256 };
  }));
  const snapshot = inputSnapshotSchema.parse({ request: binding, fingerprint, files });
  await writeAtomic((await resolveWorkspacePath(cwd, `${directory}/manifest.json`, true)).path, JSON.stringify(snapshot, null, 2));
  return snapshot;
}
