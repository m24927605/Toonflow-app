import { t, translateMessage } from "@/lib/i18n";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "@toonflow/file";
import { dirname, join } from "node:path";
import conf from "@/utils/conf";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

export type PersonalizationDocument = "memory" | "agents";

const documents = { memory: "memories/memory.md", agents: "AGENTS.md" };
const labels = { memory: "Global memory", agents: "Global AGENTS.md" };
export const maxDocumentLength = 20000;

export function isMemoryEnabled() {
  const value = conf.get("settings", {}).personalization;
  return !value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).memoryEnabled !== false;
}

function result(content: string) {
  return { content, revision: createHash("sha256").update(content).digest("hex") };
}

async function documentPath(document: PersonalizationDocument) {
  if (!Object.hasOwn(documents, document)) throw Object.assign(new Error("Invalid personalization document type"), { status: 400 });
  const directory = dirname(conf.path);
  await mkdir(directory, { recursive: true });
  const directories = [directory, ...(document === "memory" ? [join(directory, "memories")] : [])];
  for (const path of directories) {
    const info = await lstat(path).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
    if (info?.isSymbolicLink()) throw Object.assign(new Error("Personalization document cannot be accessed through a symbolic link"), { status: 403 });
    if (info && !info.isDirectory()) throw Object.assign(new Error("The path to the personalized document is not a directory"), { status: 400 });
  }
  return (await resolveWorkspacePath(await realpath(directory), documents[document], true)).path;
}

async function readContent(path: string) {
  const info = await lstat(path).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return null; throw err; });
  if (!info) return "";
  if (info.isSymbolicLink()) throw Object.assign(new Error("Personalization document cannot be accessed through a symbolic link"), { status: 403 });
  if (!info.isFile()) throw Object.assign(new Error("Personalized documents must be ordinary files"), { status: 400 });
  if (info.size > maxDocumentLength * 3 + 3) throw Object.assign(new Error(t`Personalized document cannot exceed ${maxDocumentLength} characters`), { status: 413 });
  const content = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
  if (content.length > maxDocumentLength) throw Object.assign(new Error(t`Personalized document cannot exceed ${maxDocumentLength} characters`), { status: 413 });
  return content;
}

function documentError(action: "read" | "save", document: PersonalizationDocument, cause: unknown) {
  const err = cause as NodeJS.ErrnoException & { status?: number };
  const label = translateMessage(labels[document] ?? "Personalized Document");
  const message = translateMessage(err?.message ?? String(cause));
  return Object.assign(new Error(action === "read" ? t`Failed to read ${label}: ${message}` : t`Failed to save ${label}: ${message}`, { cause }), { status: err?.status, code: err?.code });
}

export async function readDocument(document: PersonalizationDocument) {
  try {
    return result(await readContent(await documentPath(document)));
  } catch (err) { throw documentError("read", document, err); }
}

export async function saveDocument(document: PersonalizationDocument, content: string, revision: string) {
  try {
    content = content.replace(/^\uFEFF/, "");
    if (content.length > maxDocumentLength) throw Object.assign(new Error(t`Personalized document cannot exceed ${maxDocumentLength} characters`), { status: 413 });
    const path = await documentPath(document);
    const release = lockWorkspaceFiles([path]);
    try {
      const current = result(await readContent(path));
      if (revision !== current.revision) throw Object.assign(new Error("The document has been updated by other operations. Please reload and save to avoid overwriting the latest content."), { status: 409 });
      await mkdir(dirname(path), { recursive: true });
      await writeWorkspaceFile(await documentPath(document), content);
      return result(content);
    } finally { release(); }
  } catch (err) { throw documentError("save", document, err); }
}
