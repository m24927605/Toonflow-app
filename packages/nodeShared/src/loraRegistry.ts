import type { NodeLoraFamily, NodeLoraRecord } from "@toonflow/nodes-scaffold/runtime";

type WorkspaceFiles = {
  list(path?: string): Promise<{ entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  readJson<T = unknown>(path: string): Promise<T>;
};

/** A LoRA attached to a generation node: the record fields the request and the prompt need, and its strength. */
export type AttachedLora = Pick<NodeLoraRecord, "path" | "trigger" | "name" | "kind" | "family"> & { strength: number };

/** The LoRA family a media provider loads: LTX-2.3 for Sulphur 2 video, Qwen-Image for images; none for other providers. */
export const loraFamilyOf = (providerId?: string): NodeLoraFamily | undefined =>
  providerId === "sulphur" ? "ltx" : providerId === "qwenImage" ? "qwen" : undefined;

/** The workspace's trained LoRAs, read from the records beside them in `loras/`; none when the folder is missing. */
export async function listLoras(files: WorkspaceFiles) {
  const { entries } = await files.list("loras").catch(() => ({ entries: [] }));
  const records = await Promise.all(entries.filter(entry => entry.type === "file" && entry.name.endsWith(".json"))
    .map(entry => files.readJson<NodeLoraRecord>(entry.path).catch(() => undefined)));
  return records.filter((record): record is NodeLoraRecord => !!record?.trigger && !!record.path)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}


/** The attached LoRAs the chosen provider loads; others stay attached for a switch back but add no trigger words. */
export const activeLoras = (loras: AttachedLora[], providerId?: string) => loras.filter(lora => lora.family === loraFamilyOf(providerId));

/**
 * The LoRAs a node tool attaches: each path must be a trained LoRA of the given family in the workspace, and a
 * generation loads at most 4. Strength defaults to 1; sliders take -4 to 4.
 */
export function pickLoras(records: NodeLoraRecord[], family: NodeLoraFamily, picks: { path: string; strength?: number }[]): AttachedLora[] {
  if (picks.length > 4) throw new Error("A generation loads at most 4 LoRAs");
  return picks.map(({ path, strength = 1 }) => {
    const record = records.find(item => item.path === path && item.family === family);
    if (!record) throw new Error(`${path} is not a trained ${family} LoRA of this workspace; use a path that getConfig lists`);
    return { path, trigger: record.trigger, name: record.name, kind: record.kind, family, strength };
  });
}
