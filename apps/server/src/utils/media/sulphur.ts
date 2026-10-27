import { validateVideoPrompt } from "@toonflow/node-shared/videoPrompt";
import { colabLane, colabPoolRestored, colabSessionName, createColabWorker, currentColabAllocation, waitForColabPreparation, type ColabPreparation } from "./colabPool";
import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { inputBytes, inputExtension, randomSeed, type ColabSession } from "@/utils/media/colab";
import pipeline from "./sulphurColab.py" with { type: "text" };
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { unzipSync } from "fflate";

export type SulphurRequest = Parameters<ProviderTools["sulphur"]>[0];
export const clipArtifactSchema = z.object({ session: z.string().regex(/^toonflow-[0-9a-f]{8}$/), lane: z.number().int().min(1).max(3), path: z.string().regex(/^\/content\/sulphurOut\/[a-f0-9]{8}\/final\.mp4$/), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type ClipArtifact = z.infer<typeof clipArtifactSchema>;
const artifacts = new Map<string, ClipArtifact>();
type ClipPostprocess = { script: string; inputs: { name: string; data: Uint8Array }[]; arguments: string[]; roughArguments: string[]; receive: (files: Record<string, Uint8Array>) => void };
const postprocessing = new AsyncLocalStorage<ClipPostprocess>();
export const withClipPostprocess = <T>(plan: ClipPostprocess, work: () => Promise<T>) => postprocessing.run(plan, work);
export function takeClipArtifact(bytes: Uint8Array) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const artifact = artifacts.get(hash);
  if (!artifact) throw new Error("Missing clip artifact receipt");
  artifacts.delete(hash);
  return artifact;
}

const resolutions = new Set(["480p", "720p", "1080p"]);
/** Whole seconds one render covers; a longer take renders in parts. */
export const maxClipSeconds = 20;
export const maxTakeSeconds = 120;
// A long take renders as parts of one length on the VAE's 8n+1 frame grid, at most 481 frames (20 seconds); every part
// after the first opens on the last 25 frames of the one before, which it drops.
const contextFrames = 25;
const maxPartFrames = 481;
const snapped = (frames: number) => Math.max(25, frames + (8 - (frames - 1) % 8) % 8);

/**
 * How a take of `duration` seconds renders: in one part up to 20 seconds, else in the fewest parts of one length that
 * cover it, each starting `step` frames after the one before; `count` asks for that many parts instead.
 */
export function longTakeParts(duration: number, count?: number) {
  const frames = Math.round(duration * 24);
  if (!count && duration <= maxClipSeconds) return { parts: 1, frames: snapped(frames), step: 0 };
  const parts = count ?? Math.ceil((frames - contextFrames) / (maxPartFrames - contextFrames));
  const length = snapped(Math.ceil((frames - contextFrames) / parts) + contextFrames);
  return { parts, frames: length, step: length - contextFrames };
}

// Standalone requests use up to three high-RAM A100s. Production holds below reserve room for preparation, and keep
// renderers loaded across clips.
export const sulphurMachines = 3;
const workers = Array.from({ length: sulphurMachines }, (_, index) => createColabWorker("sulphur", index + 1));
const waiting = workers.map(() => 0);
const productionLimits = new Map<symbol, number>();

/** Limits rendering during preparation without pinning idle GPU sessions. */
export function limitSulphur(machines: number) {
  if (!Number.isInteger(machines) || machines < 1 || machines >= sulphurMachines) throw new Error("Production rendering needs one or two A100s");
  const allocation = currentColabAllocation();
  if (allocation) {
    const previous = allocation.renderLimit ?? allocation.renderWorkers;
    allocation.renderLimit = Math.min(machines, allocation.renderWorkers);
    return () => { allocation.renderLimit = previous; };
  }
  const key = Symbol();
  productionLimits.set(key, machines);
  return () => { productionLimits.delete(key); };
}

/** Keeps renderers warm once all preparation dependencies can complete without them. */
export function holdSulphur(machines: number) {
  const releaseLimit = limitSulphur(machines);
  const releases = workers.slice(0, machines).map(worker => worker.hold());
  return () => {
    releaseLimit();
    releases.forEach(release => release());
  };
}
// LoRA files already on a session's machine.
const sentLoras = new WeakMap<ColabSession, Set<string>>();

// The pipeline's machine setup: ComfyUI, its nodes, the weights and the server, without any clip's inputs.
const setup = `${pipeline.slice(0, pipeline.indexOf("# The machine is set up above this line"))}\nprint("COLAB_DONE")\n`;
const warmEnvironment = (resolution: string, ratio: string) => ({ SULPHUR_JOB: "warm", SULPHUR_SEED: 0, SULPHUR_RESOLUTION: resolution, SULPHUR_RATIO: ratio, SULPHUR_DURATION: 4, SULPHUR_SEGMENT_FRAMES: longTakeParts(4).frames, SULPHUR_AUDIO: 0 });
export function sulphurPreparation(resolution: string, ratio: string): ColabPreparation {
  return { name: "sulphur", runtime: "sulphur", installSource: "comfy/7f7fd918ed0815c5d5ef2ccfe44bfc8e72cfd217", prefetch: true, deferLoad: true, job: {
    script: setup, uploads: [], env: warmEnvironment(resolution, ratio), outputs: [],
  } };
}

/**
 * Starts `machines` of the A100s, as many as the clips to come can use, and sets them up for clips of this resolution
 * while other work runs, so the first clips find them ready; each is held for at most `ms`, until `signal` aborts or
 * the returned release is called.
 */
export function warmSulphur(resolution: string, ratio: string, machines: number, ms: number, signal: AbortSignal) {
  const releases = workers.slice(0, machines).map(worker => {
    const release = worker.holdFor(ms, signal);
    void waitForColabPreparation("sulphur", signal).then(() => worker.run(session => session.job({
      script: setup, uploads: [], env: warmEnvironment(resolution, ratio), outputs: [],
    }, signal), signal)).catch((error: unknown) => signal.aborted || console.error("[sulphur] Warming an A100 failed:", error));
    return release;
  });
  return () => releases.forEach(release => release());
}

/** Renders one Sulphur 2 video on Colab and returns the MP4 bytes; clips requested together run one after another on one machine. */
export async function runSulphur({ prompt, parts, firstFrame, lastFrame, controlVideo, soundtrack, loras = [], duration, resolution, ratio, audio, seed = randomSeed(), workflow = "distilled" }: SulphurRequest, signal?: AbortSignal) {
  for (const value of parts ?? [prompt]) validateVideoPrompt(value);
  if (soundtrack && !audio) throw new Error("A locked soundtrack requires audio output to be enabled");
  const plan = longTakeParts(duration, parts?.length);
  if (!parts && (!Number.isInteger(duration) || duration < 1 || duration > maxClipSeconds)) throw new Error(`Sulphur 2 renders whole seconds from 1 to ${maxClipSeconds} at a time`);
  if (parts) {
    if (!Number.isInteger(duration) || duration > maxTakeSeconds) throw new Error(`A Sulphur 2 long take is a whole number of seconds up to ${maxTakeSeconds}`);
    if (parts.length < 2 || parts.some(part => !part.trim())) throw new Error("A Sulphur 2 long take needs at least two part prompts");
    if (plan.frames > maxPartFrames || plan.step < 1) throw new Error(`A ${duration}-second Sulphur 2 long take cannot be split into ${parts.length} parts of at most 20 seconds`);
  }
  if (!resolutions.has(resolution)) throw new Error("Sulphur 2 only supports 480p, 720p and 1080p");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("Invalid Sulphur 2 aspect ratio");
  if (loras.length > 4) throw new Error("Sulphur 2 loads at most 4 LoRAs");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid Sulphur 2 seed");
  const job = crypto.randomUUID().slice(0, 8);
  const postprocess = postprocessing.getStore();
  const name = (rest: string) => `sulin_${job}_${rest}`;
  // A LoRA is named by its content and kept on the machine, so a session's later clips never upload it again.
  const characterLoras = loras.map(lora => ({ data: inputBytes(lora.file), strength: lora.strength }))
    .map(lora => ({ ...lora, name: `sulphurLora_${createHash("sha256").update(lora.data).digest("hex").slice(0, 32)}.safetensors` }));
  await waitForColabPreparation("sulphur", signal);
  signal?.throwIfAborted();
  const allocation = currentColabAllocation();
  const limit = allocation ? allocation.renderLimit ?? allocation.renderWorkers : productionLimits.size ? Math.min(...productionLimits.values()) : sulphurMachines;
  // A lane with a running machine comes first: the least queued lane was often one without a machine, and asking
  // Colab for another A100 was refused while the pool's machines could take the clip.
  await colabPoolRestored();
  const rank = (index: number) => (colabSessionName(colabLane(index + 1)) ? 0 : 100) + waiting[index]!;
  const index = Array.from({ length: limit }, (_, index) => index).reduce((best, index) => rank(index) < rank(best) ? index : best);
  waiting[index]!++;
  const video = await workers[index]!.run(async (session, sessionSignal) => {
    const sent = sentLoras.get(session) ?? new Set<string>();
    const loraUploads = [...new Map(characterLoras.filter(lora => !sent.has(lora.name)).map(lora => [lora.name, { name: lora.name, data: lora.data }])).values()];
    let [output, timings] = await session.job({
      script: pipeline + (postprocess ? "\n" + postprocess.script : ""),
      uploads: [
        ...postprocess ? [...postprocess.inputs, { name: `${job}Postprocess.json`, data: JSON.stringify({ inputs: postprocess.inputs.map(item => ({ path: `/content/${item.name}`, bytes: item.data.length, sha256: createHash("sha256").update(item.data).digest("hex") })), arguments: postprocess.arguments, roughArguments: postprocess.roughArguments }) }] : [],
        { name: name("prompt.txt"), data: prompt },
        ...parts ? [{ name: name("prompts.json"), data: JSON.stringify(parts) }] : [],
        ...firstFrame ? [{ name: name(`first.${inputExtension(firstFrame)}`), data: inputBytes(firstFrame) }] : [],
        ...lastFrame ? [{ name: name(`last.${inputExtension(lastFrame)}`), data: inputBytes(lastFrame) }] : [],
        ...controlVideo ? [{ name: name(`control.${inputExtension(controlVideo)}`), data: inputBytes(controlVideo) }] : [],
        ...soundtrack ? [{ name: name(`audio.${inputExtension(soundtrack)}`), data: inputBytes(soundtrack) }] : [],
        ...loraUploads,
        ...characterLoras.length ? [{ name: name("loras.json"), data: JSON.stringify(characterLoras.map(({ name, strength }) => ({ name, strength }))) }] : [],
      ],
      env: {
        SULPHUR_JOB: job, SULPHUR_SEED: seed, SULPHUR_RESOLUTION: resolution, SULPHUR_RATIO: ratio, SULPHUR_DURATION: duration, SULPHUR_AUDIO: audio ? 1 : 0, SULPHUR_WORKFLOW: workflow,
        SULPHUR_SEGMENTS: parts?.length ?? 1, SULPHUR_SEGMENT_FRAMES: plan.frames,
        ...postprocess ? { PRODUCTION_FINISH_JOB: job, PRODUCTION_FINISH_FUSED: 1 } : {},
      },
      outputs: postprocess ? [`/content/${job}Finished.zip`] : [`/content/sulphurOut/${job}/final.mp4`, `/content/sulphurOut/${job}/timings.json`],
    }, sessionSignal);
    if (postprocess) {
      const files = unzipSync(output!);
      if (Object.keys(files).sort().join(",") !== ["film.mp4", "result.json", "roughCut.mp4", "source.mp4", "timings.json"].sort().join(",")) throw new Error("Unexpected postproduction archive");
      const manifest = z.object({ artifacts: z.array(z.object({ file: z.enum(["film.mp4", "roughCut.mp4", "source.mp4", "timings.json"]), bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).length(4) }).parse(JSON.parse(new TextDecoder().decode(files["result.json"])));
      if (new Set(manifest.artifacts.map(item => item.file)).size !== 4 || manifest.artifacts.some(item => files[item.file]!.length !== item.bytes || createHash("sha256").update(files[item.file]!).digest("hex") !== item.sha256)) throw new Error("Postproduction archive digest mismatch");
      output = files["source.mp4"];
      timings = files["timings.json"];
      postprocess.receive(files);
    }
    for (const { name } of loraUploads) sent.add(name);
    sentLoras.set(session, sent);
    // The seconds each phase of the job took on the machine, for finding the slow ones.
    console.log(`[sulphur] Job ${job} timings: ${new TextDecoder().decode(timings)}`);
    const artifact = clipArtifactSchema.parse({ ...JSON.parse(new TextDecoder().decode(timings)).artifact, session: session.name, lane: index + 1 });
    if (artifact.bytes !== output!.length || createHash("sha256").update(output!).digest("hex") !== artifact.sha256) throw new Error("Clip artifact digest mismatch");
    if (currentColabAllocation()) artifacts.set(artifact.sha256, artifact);
    return output!;
  }, signal).finally(() => waiting[index]!--);
  return { data: video, mimeType: "video/mp4" as const, seed };
}
