import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { createColabWorker, inputBytes, inputExtension, randomSeed, type ColabSession } from "@/utils/media/colab";
import pipeline from "./minimaxH3Colab.py" with { type: "text" };

export type MinimaxH3Request = Parameters<ProviderTools["minimaxH3"]>[0];

const resolutions = new Set(["480p", "720p", "1080p"]);
// A long take renders as parts of one length on the model's 17k+5 frame grid, at most 362 frames; every part after the
// first repeats the last 22 frames of the one before, which it drops.
const contextFrames = 22;
const maxPartFrames = 362;
const snapped = (frames: number) => Math.max(124, frames + ((5 - frames % 17) % 17 + 17) % 17);

/**
 * How a take of `duration` seconds renders: in one part up to 15 seconds, else in the fewest parts of one length that
 * cover it, each starting `step` frames after the one before.
 */
export function longTakeParts(duration: number) {
  const frames = Math.round(duration * 24);
  if (duration <= 15) return { parts: 1, frames: snapped(frames), step: 0 };
  const parts = Math.ceil((frames - contextFrames) / (maxPartFrames - contextFrames));
  const length = snapped(Math.ceil((frames - contextFrames) / parts) + contextFrames);
  return { parts, frames: length, step: length - contextFrames };
}

/**
 * About how many minutes a set-up A100 takes to render a clip of `duration` seconds. ACT: measured at 720p with four
 * sampling steps on 2026-10-17, where a 124-frame part took about 2.3 minutes and a 260-frame part about 10, close to
 * frames squared times 1.5e-4, doubled for the eight steps sampled now; 480p and 1080p are scaled by the pixels they
 * sample and refine, unmeasured.
 */
export function renderMinutes(duration: number, resolution: string) {
  const plan = longTakeParts(duration);
  const scale = resolution === "480p" ? 0.4 : resolution === "1080p" ? 2.5 : 1;
  return plan.parts * plan.frames ** 2 * 3e-4 * scale;
}

// ACT: Minutes a cold A100 takes to start and set up before its first clip, measured on 2026-10-17 (about 4).
const setupMinutes = 4;
/** The minutes before the A100s can render: none while one is open or starting, else a cold start's. */
export const minimaxH3SetupMinutes = () => workers.some(worker => worker.live()) ? 0 : setupMinutes;
// Clips share high-RAM A100s kept for five idle minutes, so a batch of shots pays the ComfyUI install and the 30+ GB
// model download once a machine; the high-RAM shape is needed for those weights to pass through host memory. Two
// machines render a batch side by side, leaving Colab's third for the text model that checks the clips; each clip goes
// to the machine with the fewest waiting. ACT: The second machine pays its own start, about half a unit.
const workers = [0, 1].map(() => createColabWorker("minimaxH3", { gpu: "A100", highMem: true }, 5 * 60_000));
const waiting = workers.map(() => 0);
// Of the eight Turbo sampling steps, the reference videos condition only the first two: Code Video Model found a previs
// used beyond the first quarter of the steps passes its flat look into the clip (https://code-video-model.github.io).
const videoSteps = 2;
// LoRA files already on a session's machine.
const sentLoras = new WeakMap<ColabSession, Set<string>>();

// The pipeline's machine setup: ComfyUI, its nodes, the weights and the server, without any clip's inputs.
const setup = `${pipeline.slice(0, pipeline.indexOf("# The machine is set up above this line"))}\nprint("COLAB_DONE")\n`;

/**
 * Starts `machines` of the A100s, as many as the clips to come can use, and sets them up for clips of this resolution
 * while other work runs, so the first clips find them ready; each is held for at most `ms`, until `signal` aborts or
 * the returned release is called.
 */
export function warmMinimaxH3(resolution: string, ratio: string, machines: number, ms: number, signal: AbortSignal) {
  const releases = workers.slice(0, machines).map(worker => {
    const release = worker.holdFor(ms, signal);
    void worker.run(session => session.job({
      script: setup, uploads: [],
      env: { H3_JOB: "warm", H3_SEED: 0, H3_RESOLUTION: resolution, H3_RATIO: ratio, H3_DURATION: 4, H3_AUDIO: 0, H3_VIDEO_STEPS: videoSteps }, outputs: [],
    }, signal)).catch((error: unknown) => signal.aborted || console.error("[minimaxH3] Warming an A100 failed:", error));
    return release;
  });
  return () => releases.forEach(release => release());
}

/** Stops the A100 as soon as the clips already requested are done, for a caller that has no more to send. */
export const stopMinimaxH3WhenIdle = () => workers.forEach(worker => worker.stopWhenIdle());

/** Renders one MiniMax H3 video on Colab and returns the MP4 bytes; clips requested together run one after another on one machine. */
export async function runMinimaxH3({ prompt, parts, images = [], videos = [], audios = [], controlVideo, firstFrame, lastFrame, loras = [], duration, resolution, ratio, audio, seed = randomSeed() }: MinimaxH3Request, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("MiniMax H3 prompt cannot be empty");
  if (!parts && (!Number.isInteger(duration) || duration < 4 || duration > 15)) throw new Error("MiniMax H3 duration must be a whole number of seconds from 4 to 15");
  const plan = longTakeParts(duration);
  if (parts) {
    if (!Number.isInteger(duration) || duration <= 15 || duration > 120) throw new Error("A MiniMax H3 long take is a whole number of seconds from 16 to 120");
    if (parts.length !== plan.parts || parts.some(part => !part.trim())) throw new Error(`A ${duration}-second MiniMax H3 long take needs ${plan.parts} part prompts`);
    if (resolution === "1080p" || controlVideo || firstFrame || lastFrame) throw new Error("A MiniMax H3 long take renders at 480p or 720p, without control video or pinned frames");
  }
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
  const index = waiting.indexOf(Math.min(...waiting));
  waiting[index]!++;
  const video = await workers[index]!.run(async (session, sessionSignal) => {
    const sent = sentLoras.get(session) ?? new Set<string>();
    const loraUploads = [...new Map(characterLoras.filter(lora => !sent.has(lora.name)).map(lora => [lora.name, { name: lora.name, data: lora.data }])).values()];
    const [output] = await session.job({
    script: pipeline,
    uploads: [
      { name: name("prompt.txt"), data: prompt },
      ...parts ? [{ name: name("prompts.json"), data: JSON.stringify(parts) }] : [],
      ...images.map((image, index) => ({ name: name(`ref_${index}.${inputExtension(image)}`), data: inputBytes(image) })),
      ...videos.map((video, index) => ({ name: name(`vid_${index}.${inputExtension(video)}`), data: inputBytes(video) })),
      ...audios.map((audio, index) => ({ name: name(`aud_${index}.${inputExtension(audio)}`), data: inputBytes(audio) })),
      ...controlVideo ? [{ name: name(`control.${inputExtension(controlVideo)}`), data: inputBytes(controlVideo) }] : [],
      ...firstFrame ? [{ name: name(`first.${inputExtension(firstFrame)}`), data: inputBytes(firstFrame) }] : [],
      ...lastFrame ? [{ name: name(`last.${inputExtension(lastFrame)}`), data: inputBytes(lastFrame) }] : [],
      ...loraUploads,
      ...characterLoras.length ? [{ name: name("loras.json"), data: JSON.stringify(characterLoras.map(({ name, strength }) => ({ name, strength }))) }] : [],
    ],
    env: {
      H3_JOB: job, H3_SEED: seed, H3_RESOLUTION: resolution, H3_RATIO: ratio, H3_DURATION: duration, H3_AUDIO: audio ? 1 : 0, H3_VIDEO_STEPS: videoSteps,
      H3_SEGMENTS: parts?.length ?? 1, H3_SEGMENT_LENGTH: plan.frames,
    },
    outputs: ["/content/h3out/final.mp4"],
    }, sessionSignal);
    for (const { name } of loraUploads) sent.add(name);
    sentLoras.set(session, sent);
    return output!;
  }, signal).finally(() => waiting[index]!--);
  return { data: video, mimeType: "video/mp4" as const, seed };
}
