import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { createColabWorker, inputBytes, inputExtension, randomSeed, type ColabSession } from "@/utils/media/colab";
import pipeline from "./qwenImageColab.py" with { type: "text" };

export type QwenImageRequest = Parameters<ProviderTools["qwenImage"]>[0];
type QwenImageResult = Awaited<ReturnType<ProviderTools["qwenImage"]>>;
type Pending = { request: QwenImageRequest; signal?: AbortSignal; resolve: (result: QwenImageResult) => void; reject: (reason: unknown) => void };

// ACT: Requests are gathered until 10 s pass without a new one (60 s at most) and drawn in one Colab session, so
// setup is paid once per batch. Only one session runs at a time; requests arriving meanwhile form the next batch.
// The batch is in-process state, like the other utility singletons; tune these values if users batch differently.
const quietWindow = 10_000;
const maxWait = 60_000;
const maxBatch = 32;

// ACT: The high-RAM shape is required: the Qwen-Image weights (30+ GB) passed through host memory crashed the standard
// shape's kernel. It needs Colab Pro or Pro+, which A100 access already implies.
// The session stops as soon as a batch ends, unless a caller holds it for a batch that depends on this one.
const worker = createColabWorker("qwenImage", { gpu: "A100", highMem: true }, 0);
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
  const live = new Set(batch);
  for (const item of batch) {
    item.signal?.addEventListener("abort", () => {
      live.delete(item);
      item.reject(item.signal!.reason);
      if (!live.size) controller.abort();
    }, { once: true });
  }
  try {
    // A LoRA is named by its content: a batch sends each one once, and a later batch on the same machine never
    // picks up a different file under the same name.
    const loraName = (file: Uint8Array) => `qwin_lora_${createHash("sha256").update(file).digest("hex").slice(0, 32)}.safetensors`;
    const loras = batch.map(({ request }) => (request.loras ?? []).map(lora => ({ data: inputBytes(lora.file), strength: lora.strength })).map(lora => ({ ...lora, name: loraName(lora.data) })));
    const items = batch.map(({ request }, index) => ({
      prompt: request.prompt,
      ratio: request.ratio,
      size: request.size,
      seed: randomSeed(),
      refs: (request.images ?? []).map((image, refIndex) => `qwin_${index}_${refIndex}.${inputExtension(image)}`),
      control: request.controlImage ? `qwin_${index}_control.${inputExtension(request.controlImage)}` : null,
      loras: loras[index]!.map(({ name, strength }) => ({ name, strength })),
    }));
    const results = await worker.run(async (session, signal) => {
      const sent = sentLoras.get(session) ?? new Set<string>();
      const loraUploads = [...new Map(loras.flat().filter(lora => !sent.has(lora.name)).map(lora => [lora.name, { name: lora.name, data: lora.data }])).values()];
      const outputs = await session.job({
        script: pipeline,
        uploads: [
          { name: "qwin_job.json", data: JSON.stringify(items) },
          ...batch.flatMap(({ request }, index) => (request.images ?? []).map((image, refIndex) => ({ name: items[index]!.refs[refIndex]!, data: inputBytes(image) }))),
          ...batch.flatMap(({ request }, index) => request.controlImage ? [{ name: items[index]!.control!, data: inputBytes(request.controlImage) }] : []),
          ...loraUploads,
        ],
        env: {},
        outputs: batch.map((_, index) => `/content/qwout/image_${index}.png`),
      }, signal);
      for (const { name } of loraUploads) sent.add(name);
      sentLoras.set(session, sent);
      return outputs;
    }, controller.signal);
    batch.forEach((item, index) => item.resolve({ data: results[index]!, mimeType: "image/png" }));
  } catch (error) {
    for (const item of batch) item.reject(error);
  } finally {
    running = false;
    schedule();
  }
}

/**
 * Keeps the Qwen-Image session open between batches until the returned release is called, for a caller whose next
 * batch depends on this one, such as a production's other keyframes on its master; release in a finally block.
 */
export const holdQwenImage = () => worker.hold();

/** Queues one Qwen-Image 2.1 Turbo image; it is drawn on Colab together with the other requests of its batch. */
export function runQwenImage(request: QwenImageRequest, signal?: AbortSignal) {
  if (!request.prompt.trim()) throw new Error("Qwen-Image prompt cannot be empty");
  if (request.size !== "1K" && request.size !== "2K") throw new Error("Qwen-Image only supports 1K and 2K");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(request.ratio)) throw new Error("Invalid Qwen-Image aspect ratio");
  if ((request.images?.length ?? 0) > 16) throw new Error("Qwen-Image supports at most 16 reference images");
  if ((request.loras?.length ?? 0) > 4) throw new Error("Qwen-Image loads at most 4 LoRAs");
  for (const image of [...request.images ?? [], ...request.controlImage ? [request.controlImage] : []]) inputBytes(image);
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
