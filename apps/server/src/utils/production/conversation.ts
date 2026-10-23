import { z } from "zod";
import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { dirname } from "node:path";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory } from "./state";
import { referenceAttachmentSchema } from "./references";

export const conversationTurnSchema = z.strictObject({
  id: z.string().uuid(), at: z.string().datetime({ offset: true }), locale: z.enum(["zh-TW", "zh-CN", "en"]),
  message: z.string().min(1).max(20000), status: z.enum(["pending", "answered", "failed"]), started: z.boolean().optional(), notice: z.boolean().optional(),
  attachments: z.array(referenceAttachmentSchema).max(10).optional(),
  productionRequested: z.literal(true).optional(),
  reply: z.string().min(1).max(2000).optional(), error: z.string().optional(), seconds: z.number().finite().nonnegative().optional(),
  change: z.strictObject({ text: z.string().min(1).max(2000), status: z.enum(["draft", "queued", "applying", "applied"]) }).optional(),
});
const conversationSchema = z.strictObject({ version: z.literal(1), brief: z.string().min(1).max(20000).optional(), turns: z.array(conversationTurnSchema) }).refine(value => new Set(value.turns.map(turn => turn.id)).size === value.turns.length, "Conversation message IDs must be unique");
export type ProductionConversation = z.infer<typeof conversationSchema>;
const writes = new Map<string, Promise<void>>();

async function conversationPath(cwd: string, id: string) {
  return (await resolveWorkspacePath(cwd, `${productionDirectory(id)}/conversation.json`, true)).path;
}

export async function readConversation(cwd: string, id: string): Promise<ProductionConversation> {
  const path = await conversationPath(cwd, id);
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (content === undefined) return { version: 1, turns: [] };
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Conversation exceeds 2 MiB");
  return conversationSchema.parse(JSON.parse(content));
}

/** Serialize conversation transactions independently of background production snapshots. */
export async function updateConversation<T>(cwd: string, id: string, update: (conversation: ProductionConversation) => T | Promise<T>): Promise<T> {
  const path = await conversationPath(cwd, id);
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.then(async () => {
    const conversation = await readConversation(cwd, id);
    const result = await update(conversation);
    const content = JSON.stringify(conversationSchema.parse(conversation), null, 2) + "\n";
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Conversation exceeds 2 MiB");
    await mkdir(dirname(path), { recursive: true });
    await writeAtomic(path, content);
    return result;
  });
  const settled = next.then(() => undefined, () => undefined);
  writes.set(path, settled);
  void settled.then(() => { if (writes.get(path) === settled) writes.delete(path); });
  return next;
}
