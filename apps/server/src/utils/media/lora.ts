import { mkdir, readFile } from "@toonflow/file";
import { dirname } from "node:path";
import { openColabSession } from "@/utils/media/colab";
import { runQwenImage } from "@/utils/media/qwenImage";
import { resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import pipeline from "./loraColab.py" with { type: "text" };

export const loraKinds = ["character", "scene", "costume", "style", "motion", "voice", "slider"] as const;
export type LoraKind = typeof loraKinds[number];
export type LoraFamily = "h3" | "qwen";
export type LoraInput = {
  /** One LoRA per family, trained side by side from the same items. */
  kind: LoraKind; families: LoraFamily[]; name: string;
  /** Workspace images, clips or recordings; a caption, such as a voice line's transcript, replaces the automatic one. */
  items: { path: string; caption?: string }[];
  /** A slider's two ends, added to the base prompt: +1 at full strength, -1 at negative strength. */
  slider?: { base: string; positive: string; negative: string };
  /** The trigger word of a family's LoRA when the caller fixed it beforehand; otherwise a new one is drawn. */
  triggers?: Partial<Record<LoraFamily, string>>;
};
/** Stored beside each LoRA as `loras/<trigger>.json`, so nodes find the workspace's LoRAs and their trigger words. */
export type LoraRecord = { name: string; kind: LoraKind; family: LoraFamily; trigger: string; path: string; createdAt: string };

// A thin character or scene set is topped up to about this many images with generated variants of its first image.
const minImages = 12;
const topUpTo = 16;
const rules: Partial<Record<LoraKind, string>> = {
  character: "The person is exactly the one shown in {{ref 1}}: the same face, eyes, nose, lips, skin tone, hairstyle and body. Only the clothing and the place change.",
  scene: "The place is exactly the one shown in {{ref 1}}, seen from the same side: the same architecture, materials, furniture and layout, every object where it is in {{ref 1}}.",
};
// Framing is spelled out because Qwen-Image otherwise copies the reference's composition. Characters change clothing
// and place so the LoRA learns only the person; scenes keep the reference's viewpoint, because views it does not show
// are invented and teach a different room.
const variants: Partial<Record<LoraKind, [ratio: string, scene: string][]>> = {
  character: [
    ["1:1", "Tight close-up of the person's face filling the frame, gentle smile, wearing a plain white T-shirt, soft window light from the left, plain grey background."],
    ["1:1", "Tight close-up of the person's face filling the frame, serious expression, wearing a black turtleneck, warm lamp light, dark background."],
    ["1:1", "Tight close-up of the person's face filling the frame, laughing with an open mouth, wearing a denim jacket, bright daylight, blurred green background."],
    ["1:1", "Tight close-up of the person's face filling the frame, neutral expression, wearing a grey hoodie, even studio light, white background."],
    ["1:1", "Close-up side profile of the person facing left, calm expression, wearing a navy coat, soft daylight on a city street."],
    ["1:1", "Close-up side profile of the person facing right, slight smile, wearing a striped shirt, soft backlight, dark background."],
    ["1:1", "Close-up three-quarter view of the person looking slightly down, thoughtful expression, wearing a beige knit sweater, overcast light in a cafe."],
    ["3:4", "Half-body shot of the person sitting at a wooden kitchen table, looking at the camera, wearing a checked flannel shirt, warm evening light."],
    ["3:4", "Half-body shot of the person standing in a city park, relaxed smile, wearing a light trench coat, soft afternoon light."],
    ["2:3", "Full-body shot of the person standing on a beach, facing the camera, wearing a T-shirt and jeans, bright daylight."],
    ["2:3", "Full-body shot of the person walking on an office corridor, wearing a dark business suit, cool fluorescent light."],
    ["3:4", "Half-body shot of the person in a library between bookshelves, wearing a cardigan, soft lamp light."],
  ],
  scene: [
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, soft morning daylight."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, warm evening lamp light."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, at night lit only by its lamps."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, overcast grey light."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, golden hour light."],
    ["16:9", "The left half of the place in {{ref 1}}, seen a little closer, empty, soft daylight."],
    ["16:9", "The right half of the place in {{ref 1}}, seen a little closer, empty, warm lamp light."],
    ["16:9", "The centre of the place in {{ref 1}}, seen closer, empty, soft daylight."],
    ["16:9", "The place in {{ref 1}} from the same side, the camera a few steps further back and lower, empty, evening light."],
    ["16:9", "The place in {{ref 1}} from the same side, the camera slightly to the left, empty, morning light."],
    ["16:9", "The place in {{ref 1}} from the same side, the camera slightly to the right, empty, lamp light."],
  ],
};

async function topUp(kind: LoraKind, reference: Uint8Array, count: number, signal?: AbortSignal) {
  const image = { type: "binary" as const, data: reference, mimeType: "image/png" };
  const scenes = (variants[kind] ?? []).slice(0, count);
  const results = await Promise.all(scenes.map(([ratio, scene]) => runQwenImage({
    prompt: `${scene} ${rules[kind]} One single photograph, photorealistic, sharp focus, natural texture, no text.`, ratio, size: "1K", images: [image],
  }, signal)));
  return results.map(result => result.data);
}

// Trainings running in this process, by workspace, kind and name.
const training = new Set<string>();

// A trigger word of plain letters the text encoder has no meaning for, so the LoRA owns it.
export const triggerWord = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), value => String.fromCharCode(97 + value % 26)).join("");

/**
 * Trains a LoRA for each model family on its own Colab L4 at the same time and saves each with its record in the
 * workspace's `loras/` folder. MiniMax H3 LoRAs learn from images, clips and voice recordings and serve video nodes;
 * Qwen-Image 2.1 LoRAs learn from images and serve image nodes. The job writes the captions, leaving out what the LoRA
 * learns, and crops faces for characters; a character or scene set under `minImages` images is first topped up once
 * with Qwen-Image variants of its first image, shared by every family.
 */
export async function trainLora(cwd: string, input: LoraInput, signal?: AbortSignal): Promise<LoraRecord[]> {
  // Training outlives the page, so a reopened page could start the same paid training again.
  const key = JSON.stringify([cwd, input.kind, input.name]);
  if (training.has(key)) throw new Error(`The ${input.kind} LoRA "${input.name}" is already training; it appears in the LoRA menus when it finishes`);
  training.add(key);
  try {
    return await trainSet(cwd, input, signal);
  } finally {
    training.delete(key);
  }
}

async function trainSet(cwd: string, input: LoraInput, signal?: AbortSignal) {
  const sources = await Promise.all(input.items.map(async ({ path, caption }) => ({
    extension: path.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "png", caption,
    data: new Uint8Array(await readFile((await resolveWorkspacePath(cwd, path)).path, { signal })),
  })));
  const extra = variants[input.kind] && sources.length && sources.length < minImages
    ? await topUp(input.kind, sources[0]!.data, topUpTo - sources.length, signal) : [];
  const items = [...sources, ...extra.map(data => ({ extension: "png", caption: undefined, data }))];
  // A family that fails does not stop the other, whose LoRA is kept; the error names what failed.
  const results = await Promise.allSettled(input.families.map(family => trainFamily(cwd, input, family, items, signal)));
  const failed = results.flatMap((result, index) => result.status === "rejected"
    ? [`${input.families[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
  const records = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (failed.length) throw new Error(`LoRA training failed for ${failed.join("; ")}${records.length ? ` (saved: ${records.map(record => record.trigger).join(", ")})` : ""}`);
  return records;
}

async function trainFamily(cwd: string, input: LoraInput, family: LoraFamily, items: { extension: string; caption?: string; data: Uint8Array }[], signal?: AbortSignal) {
  const trigger = input.triggers?.[family] ?? triggerWord();
  const uploads = items.flatMap(({ extension, caption, data }, index) => {
    const name = `lora_item_${String(index).padStart(2, "0")}`;
    return [{ name: `${name}.${extension}`, data }, ...caption ? [{ name: `${name}.txt`, data: caption.replaceAll("{trigger}", trigger) }] : []];
  });
  const job = { trigger, family, kind: input.kind, ...input.slider ? { slider: input.slider } : {} };
  const session = await openColabSession("loraTraining", { gpu: "L4" }, signal);
  let lora: Uint8Array;
  try {
    // Training runs for hours, so it runs detached and survives the host's network dropping for a while.
    [lora] = await session.job({ script: pipeline, uploads: [{ name: "lora_job.json", data: JSON.stringify(job) }, ...uploads], env: {}, outputs: ["/content/lora_final.safetensors"], detached: true }, signal) as [Uint8Array];
  } catch (error) {
    await session.close(error);
    throw error;
  }
  // The LoRA is saved before the session stops, and a stop that keeps failing (host offline) is logged rather than
  // failing the job: by the time it gives up, the VM watchdog has released the idle session.
  const record: LoraRecord = { name: input.name, kind: input.kind, family, trigger, path: `loras/${trigger}.safetensors`, createdAt: new Date().toISOString() };
  try {
    const target = await resolveWorkspacePath(cwd, record.path, true);
    await mkdir(dirname(target.path), { recursive: true });
    await writeWorkspaceFile(target.path, lora, true);
    await writeWorkspaceFile((await resolveWorkspacePath(cwd, `loras/${trigger}.json`, true)).path, `${JSON.stringify(record, null, 2)}\n`, true);
  } finally {
    await session.close().catch((error: unknown) => console.error("[colab] Session stop failed after LoRA training; check with `colab sessions`:", error));
  }
  return record;
}
