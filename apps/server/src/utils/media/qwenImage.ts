import type { ProviderTools } from "@toonflow/providers";
import { inputBytes, inputExtension, randomSeed, runColabJob } from "@/utils/media/colab";
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
    const items = batch.map(({ request }, index) => ({
      prompt: request.prompt,
      ratio: request.ratio,
      size: request.size,
      seed: randomSeed(),
      refs: (request.images ?? []).map((image, refIndex) => `qwin_${index}_${refIndex}.${inputExtension(image)}`),
    }));
    const results = await runColabJob({
      script: pipeline,
      uploads: [
        { name: "qwin_job.json", data: JSON.stringify(items) },
        ...batch.flatMap(({ request }, index) => (request.images ?? []).map((image, refIndex) => ({ name: items[index]!.refs[refIndex]!, data: inputBytes(image) }))),
      ],
      env: {},
      outputs: batch.map((_, index) => `/content/qwout/image_${index}.png`),
    }, controller.signal);
    batch.forEach((item, index) => item.resolve({ data: results[index]!, mimeType: "image/png" }));
  } catch (error) {
    for (const item of batch) item.reject(error);
  } finally {
    running = false;
    schedule();
  }
}

/** Queues one Qwen-Image 2.1 Turbo image; it is drawn on Colab together with the other requests of its batch. */
export function runQwenImage(request: QwenImageRequest, signal?: AbortSignal) {
  if (!request.prompt.trim()) throw new Error("Qwen-Image 提示词不能为空");
  if (request.size !== "1K" && request.size !== "2K") throw new Error("Qwen-Image 只支持 1K 和 2K");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(request.ratio)) throw new Error("Qwen-Image 画面比例无效");
  if ((request.images?.length ?? 0) > 16) throw new Error("Qwen-Image 最多支持 16 张参考图片");
  for (const image of request.images ?? []) inputBytes(image);
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
