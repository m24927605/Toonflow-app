import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { createColabWorker, inputBytes, inputExtension, randomSeed, type ColabSession } from "@/utils/media/colab";
import pipeline from "./minimaxH3Colab.py" with { type: "text" };

export type MinimaxH3Request = Parameters<ProviderTools["minimaxH3"]>[0];

const resolutions = new Set(["480p", "720p", "1080p"]);
// Clips share one high-RAM A100 kept for five idle minutes, so a batch of shots pays the ComfyUI install and the
// 30+ GB model download once; the high-RAM shape is needed for those weights to pass through host memory.
const worker = createColabWorker("minimaxH3", { gpu: "A100", highMem: true }, 5 * 60_000);
// Of the four Turbo sampling steps, the reference videos condition only the first: Code Video Model found a previs
// used beyond the first quarter of the steps passes its flat look into the clip (https://code-video-model.github.io).
const videoSteps = 1;
// LoRA files already on a session's machine.
const sentLoras = new WeakMap<ColabSession, Set<string>>();

// The pipeline's machine setup: ComfyUI, its nodes, the weights and the server, without any clip's inputs.
const setup = `${pipeline.slice(0, pipeline.indexOf("# The machine is set up above this line"))}\nprint("COLAB_DONE")\n`;

/**
 * Starts the A100 and sets it up for clips of this resolution while other work runs, so the first clip finds it ready,
 * and holds it for at most `ms`.
 */
export function warmMinimaxH3(resolution: string, ratio: string, ms: number) {
  worker.holdFor(ms);
  void worker.run(session => session.job({
    script: setup, uploads: [],
    env: { H3_JOB: "warm", H3_SEED: 0, H3_RESOLUTION: resolution, H3_RATIO: ratio, H3_DURATION: 4, H3_AUDIO: 0, H3_VIDEO_STEPS: videoSteps }, outputs: [],
  })).catch((error: unknown) => console.error("[minimaxH3] Warming the A100 failed:", error));
}

/** Stops the A100 as soon as the clips already requested are done, for a caller that has no more to send. */
export const stopMinimaxH3WhenIdle = () => worker.stopWhenIdle();

/** Renders one MiniMax H3 video on Colab and returns the MP4 bytes; clips requested together run one after another on one machine. */
export async function runMinimaxH3({ prompt, images = [], videos = [], audios = [], controlVideo, firstFrame, lastFrame, loras = [], duration, resolution, ratio, audio, seed = randomSeed() }: MinimaxH3Request, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("MiniMax H3 prompt cannot be empty");
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("MiniMax H3 duration must be a whole number of seconds from 4 to 15");
  if (!resolutions.has(resolution)) throw new Error("MiniMax H3 only supports 480p, 720p and 1080p");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("Invalid MiniMax H3 aspect ratio");
  if (images.length > 9) throw new Error("MiniMax H3 supports at most 9 reference images");
  if (videos.length > 3) throw new Error("MiniMax H3 supports at most 3 reference videos");
  if (audios.length > 3) throw new Error("MiniMax H3 supports at most 3 reference audio clips");
  if (loras.length > 4) throw new Error("MiniMax H3 loads at most 4 LoRAs");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid MiniMax H3 seed");
  const job = crypto.randomUUID().slice(0, 8);
  const name = (rest: string) => `h3in_${job}_${rest}`;
  // A LoRA is named by its content and kept on the machine, so a session's later clips never upload it again.
  const characterLoras = loras.map(lora => ({ data: inputBytes(lora.file), strength: lora.strength }))
    .map(lora => ({ ...lora, name: `h3lora_${createHash("sha256").update(lora.data).digest("hex").slice(0, 32)}.safetensors` }));
  const video = await worker.run(async (session, sessionSignal) => {
    const sent = sentLoras.get(session) ?? new Set<string>();
    const loraUploads = [...new Map(characterLoras.filter(lora => !sent.has(lora.name)).map(lora => [lora.name, { name: lora.name, data: lora.data }])).values()];
    const [output] = await session.job({
    script: pipeline,
    uploads: [
      { name: name("prompt.txt"), data: prompt },
      ...images.map((image, index) => ({ name: name(`ref_${index}.${inputExtension(image)}`), data: inputBytes(image) })),
      ...videos.map((video, index) => ({ name: name(`vid_${index}.${inputExtension(video)}`), data: inputBytes(video) })),
      ...audios.map((audio, index) => ({ name: name(`aud_${index}.${inputExtension(audio)}`), data: inputBytes(audio) })),
      ...controlVideo ? [{ name: name(`control.${inputExtension(controlVideo)}`), data: inputBytes(controlVideo) }] : [],
      ...firstFrame ? [{ name: name(`first.${inputExtension(firstFrame)}`), data: inputBytes(firstFrame) }] : [],
      ...lastFrame ? [{ name: name(`last.${inputExtension(lastFrame)}`), data: inputBytes(lastFrame) }] : [],
      ...loraUploads,
      ...characterLoras.length ? [{ name: name("loras.json"), data: JSON.stringify(characterLoras.map(({ name, strength }) => ({ name, strength }))) }] : [],
    ],
    env: { H3_JOB: job, H3_SEED: seed, H3_RESOLUTION: resolution, H3_RATIO: ratio, H3_DURATION: duration, H3_AUDIO: audio ? 1 : 0, H3_VIDEO_STEPS: videoSteps },
    outputs: ["/content/h3out/final.mp4"],
    }, sessionSignal);
    for (const { name } of loraUploads) sent.add(name);
    sentLoras.set(session, sent);
    return output!;
  }, signal);
  return { data: video, mimeType: "video/mp4" as const, seed };
}
