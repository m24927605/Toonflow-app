import { createColabWorker, waitForColabPreparation, type ColabPreparation } from "./colabPool";
import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { inputBytes, inputExtension, randomSeed, type ColabSession } from "@/utils/media/colab";
import pipeline from "./qwenImageColab.py" with { type: "text" };

export type QwenImageRequest = Parameters<ProviderTools["qwenImage"]>[0];
type QwenImageResult = Awaited<ReturnType<ProviderTools["qwenImage"]>>;
type Pending = { request: QwenImageRequest; signal?: AbortSignal; resolve: (result: QwenImageResult) => void; reject: (reason: unknown) => void };

// Batch requests arriving in the same burst; the shared VM already preserves setup between batches.
const quietWindow = 50;
const maxWait = 250;
const maxBatch = 32;

// ACT: The high-RAM shape is required: the Qwen-Image weights (30+ GB) passed through host memory crashed the standard
// shape's kernel. It needs Colab Pro or Pro+, which A100 access already implies.
// Production owns the VM lifetime; this worker owns image jobs on its shared lane.
const worker = createColabWorker("qwenImage", 1);
export function qwenImagePreparation(recipes: "pose"[]): ColabPreparation {
  return { name: recipes.includes("pose") ? "imagePose" : "image", runtime: "qwenImage", installSource: "comfy/7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217", prefetch: true, job: {
    script: `${pipeline.slice(0, pipeline.indexOf("def build(item):"))}\nprint("COLAB_DONE")\n`,
    uploads: [{ name: "qwin_job.json", data: JSON.stringify([{}, ...recipes.map(recipe => ({ recipe }))].map(item => ({ refs: [], size: "1K", ratio: "16:9", ...item }))) }],
    env: { QWEN_JOB: "00000000-0000-0000-0000-000000000000" }, outputs: [],
  } };
}
// LoRA files already on a session's machine, so a held session receives each LoRA once.
const sentLoras = new WeakMap<ColabSession, Set<string>>();

let pending: Pending[] = [];
let firstQueuedAt: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;

function schedule() {
  clearTimeout(timer);
  if (!pending.length) firstQueuedAt = undefined;
  if (running || !pending.length) return;
  firstQueuedAt ??= Date.now();
  timer = setTimeout(() => void drawBatch(), Math.max(0, Math.min(quietWindow, firstQueuedAt + maxWait - Date.now())));
}

async function drawBatch() {
  firstQueuedAt = undefined;
  const batch = pending.splice(0, maxBatch);
  if (!batch.length) return;
  running = true;
  // The session stops early only when every request in the batch has been cancelled.
  const controller = new AbortController();
  const job = crypto.randomUUID();
  const live = new Set(batch);
  for (const item of batch) {
    item.signal?.addEventListener("abort", () => {
      if (!live.delete(item)) return;
      item.reject(item.signal!.reason);
      if (!live.size) controller.abort();
    }, { once: true });
  }
  try {
    // A LoRA is named by its content: a batch sends each one once, and a later batch on the same machine never
    // picks up a different file under the same name.
    const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 32);
    const loraName = (file: Uint8Array) => `qwin_lora_${digest(file)}.safetensors`;
    // Images are named by their content too, so a batch sends a place or person shared by its keyframes once: each
    // upload is a CLI call on the paid machine.
    const imageName = (image: NonNullable<QwenImageRequest["controlImage"]>) => `qwin_image_${digest(inputBytes(image))}.${inputExtension(image)}`;
    const loras = batch.map(({ request }) => (request.loras ?? []).map(lora => ({ data: inputBytes(lora.file), strength: lora.strength })).map(lora => ({ ...lora, name: loraName(lora.data) })));
    const items = batch.map(({ request }, index) => ({
      prompt: request.prompt,
      ratio: request.ratio,
      size: request.size,
      seed: request.seed ?? randomSeed(),
      refs: (request.images ?? []).map(imageName),
      control: request.controlImage ? imageName(request.controlImage) : null,
      init: request.initImage ? imageName(request.initImage) : null,
      denoise: request.initImage ? request.denoise : null,
      recipe: request.recipe ?? null,
      loras: loras[index]!.map(({ name, strength }) => ({ name, strength })),
    }));
    await worker.run(async (session, signal) => {
      const sent = sentLoras.get(session) ?? new Set<string>();
      const loraUploads = [...new Map(loras.flat().filter(lora => !sent.has(lora.name)).map(lora => [lora.name, { name: lora.name, data: lora.data }])).values()];
      await session.job({
        script: pipeline,
        uploads: [
          { name: "qwin_job.json", data: JSON.stringify(items) },
          ...new Map(batch.flatMap(({ request }) => [...request.images ?? [], ...request.controlImage ? [request.controlImage] : [], ...request.initImage ? [request.initImage] : []])
            .map(image => [imageName(image), { name: imageName(image), data: inputBytes(image) }])).values(),
          ...loraUploads,
        ],
        env: { QWEN_JOB: job },
        outputs: batch.map((_, index) => `/content/qwout/${job}/image_${index}.png`),
        onOutput: (index, data) => {
          const item = batch[index]!;
          live.delete(item);
          item.resolve({ data, mimeType: "image/png", seed: items[index]!.seed });
        },
      }, signal);
      for (const { name } of loraUploads) sent.add(name);
      sentLoras.set(session, sent);
    }, controller.signal);
  } catch (error) {
    for (const item of batch) item.reject(error);
  } finally {
    running = false;
    schedule();
  }
}

/**
 * Keeps the Qwen-Image session open between batches until the returned release is called, for a caller whose next
 * batch depends on this one, such as a production's poses on its designs; release in a finally block. With `ms`, the
 * hold ends by itself after that long or when `signal` aborts, so a stalled caller cannot keep the machine on.
 */
export const holdQwenImage = (ms?: number, signal?: AbortSignal) => ms ? worker.holdFor(ms, signal) : worker.hold();

/** Queues one Qwen-Image 2.1 image, drawn by the base model with the anatomy LoRA; it is drawn on Colab together with the other requests of its batch. */
export async function runQwenImage(request: QwenImageRequest, signal?: AbortSignal) {
  if (!request.prompt.trim()) throw new Error("Qwen-Image prompt cannot be empty");
  if (request.size !== "1K" && request.size !== "2K") throw new Error("Qwen-Image only supports 1K and 2K");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(request.ratio)) throw new Error("Invalid Qwen-Image aspect ratio");
  if ((request.images?.length ?? 0) > 10) throw new Error("Qwen-Image 2.1 supports at most 10 reference images");
  if ((request.loras?.length ?? 0) > 4) throw new Error("Qwen-Image loads at most 4 LoRAs");
  if (request.seed !== undefined && (!Number.isSafeInteger(request.seed) || request.seed < 0)) throw new Error("Invalid Qwen-Image seed");
  if (request.recipe === "pose" && (request.images?.length ?? 0) < 2) throw new Error("Pose transfer needs a mannequin render and a picture of the person");
  if (request.initImage && !(typeof request.denoise === "number" && request.denoise > 0 && request.denoise <= 1)) throw new Error("Redrawing an image with Qwen-Image needs a denoise above 0 and up to 1");
  // Official 2.1 editing syntax: natural references for one image, <imageN> for multiple images.
  // https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt
  const imageCount = request.images?.length ?? 0;
  const prompt = request.prompt.replace(/\{\{ref\s+(\d+)\}\}|<image\s*(\d+)>/gi, (_match, ref: string | undefined, image: string | undefined) => {
    const index = Number(ref ?? image);
    if (index < 1 || index > imageCount) throw Object.assign(new Error(`Qwen-Image prompt references image ${index}, but only ${imageCount} reference images are connected`), { status: 400 });
    return imageCount === 1 ? "the image" : `<image${index}>`;
  });
  if (/\{\{ref\b/i.test(prompt)) throw Object.assign(new Error("Qwen-Image prompt contains an unresolved reference placeholder"), { status: 400 });
  if (imageCount > 1) for (let index = 1; index <= imageCount; index++) {
    if (!prompt.includes(`<image${index}>`)) throw Object.assign(new Error(`Qwen-Image editing prompt must identify the role of reference <image${index}>`), { status: 400 });
  }
  request = { ...request, prompt };
  for (const image of [...request.images ?? [], ...request.controlImage ? [request.controlImage] : [], ...request.initImage ? [request.initImage] : []]) inputBytes(image);
  signal?.throwIfAborted();
  if (request.recipe !== undefined && request.recipe !== "pose") throw Object.assign(new Error("This production uses the B3 image recipes only"), { status: 400 });
  await waitForColabPreparation(request.recipe === "pose" ? "imagePose" : "image", signal);
  signal?.throwIfAborted();
  return new Promise<QwenImageResult>((resolve, reject) => {
    const item: Pending = { request, signal, resolve, reject };
    pending.push(item);
    signal?.addEventListener("abort", () => {
      if (!pending.includes(item)) return;
      pending = pending.filter(other => other !== item);
      reject(signal.reason);
      schedule();
    }, { once: true });
    schedule();
  });
}
