import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { colabLane, colabPoolRestored, colabSessionName, createColabWorker } from "./colabPool";
import { inputBytes, inputExtension, randomSeed } from "@/utils/media/colab";
import pipeline from "./erosV5Colab.py" with { type: "text" };
import workflow from "./erosV5Workflow.json";

export type ErosV5Request = Parameters<ProviderTools["erosV5"]>[0];

// The workflow's sliders take any size on its 32-pixel grid; these short sides keep the requested resolution's name
// on that grid (720p renders 768 pixels high, as the workflow was verified).
const shortSides: Record<string, number> = { "480p": 512, "720p": 768, "1080p": 1088 };
/** The longest clip, the workflow's own default length of 360 frames. */
export const maxErosV5Seconds = 15;
// The A100 lanes other than lane 2, preferring one with a running machine; H3 keeps lane 2's disk.
const lanes = [1, 3];
const workers = lanes.map(lane => createColabWorker("erosV5", lane));
const waiting = workers.map(() => 0);

/** The width and height the workflow's sliders get for a resolution and an aspect ratio such as 16:9. */
export function erosV5Size(resolution: string, ratio: string) {
  const [ratioWidth, ratioHeight] = ratio.split(":").map(Number) as [number, number];
  const short = shortSides[resolution]!;
  const long = Math.round(short * Math.max(ratioWidth, ratioHeight) / Math.min(ratioWidth, ratioHeight) / 32) * 32;
  return ratioWidth >= ratioHeight ? { width: long, height: short } : { width: short, height: long };
}

/** Renders one clip with TenStrip's 10Eros V5 workflow on Colab from a start image and returns the MP4 bytes. */
export async function runErosV5({ prompt, firstFrame, soundtrack, duration, resolution, ratio, audio, seed = randomSeed() }: ErosV5Request, signal?: AbortSignal) {
  if (soundtrack && !audio) throw new Error("A locked soundtrack requires audio output to be enabled");
  if (!prompt.trim()) throw new Error("The 10Eros V5 prompt cannot be empty");
  if (!Number.isInteger(duration) || duration < 1 || duration > maxErosV5Seconds) throw new Error(`10Eros V5 renders whole seconds from 1 to ${maxErosV5Seconds}`);
  if (!shortSides[resolution]) throw new Error("10Eros V5 only supports 480p, 720p and 1080p");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("Invalid 10Eros V5 aspect ratio");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid 10Eros V5 seed");
  const { width, height } = erosV5Size(resolution, ratio);
  const job = crypto.randomUUID().slice(0, 8);
  const name = (rest: string) => `erosin_${job}_${rest}`;
  await colabPoolRestored();
  const rank = (index: number) => (colabSessionName(colabLane(lanes[index]!)) ? 0 : 100) + waiting[index]!;
  const index = workers.map((_, index) => index).reduce((best, index) => rank(index) < rank(best) ? index : best);
  waiting[index]!++;
  const video = await workers[index]!.run(async (session, sessionSignal) => {
    const [output, timings] = await session.job({
      script: pipeline,
      uploads: [
        { name: name("prompt.txt"), data: prompt },
        { name: name(`first.${inputExtension(firstFrame)}`), data: inputBytes(firstFrame) },
        ...soundtrack ? [{ name: name(`audio.${inputExtension(soundtrack)}`), data: inputBytes(soundtrack) }] : [],
        { name: name("workflow.json"), data: JSON.stringify(workflow) },
      ],
      env: { EROS_JOB: job, EROS_SEED: seed, EROS_WIDTH: width, EROS_HEIGHT: height, EROS_FRAMES: duration * 24, EROS_AUDIO: audio ? 1 : 0 },
      outputs: [`/content/erosOut/${job}/final.mp4`, `/content/erosOut/${job}/timings.json`],
    }, sessionSignal);
    const report = JSON.parse(new TextDecoder().decode(timings)) as { artifact: { bytes: number; sha256: string } };
    // The seconds each phase of the job took on the machine, for finding the slow ones.
    console.log(`[erosV5] Job ${job} timings: ${JSON.stringify(report)}`);
    if (report.artifact.bytes !== output!.length || createHash("sha256").update(output!).digest("hex") !== report.artifact.sha256) throw new Error("10Eros V5 clip digest mismatch");
    return output!;
  }, signal).finally(() => waiting[index]!--);
  return { data: video, mimeType: "video/mp4" as const, seed };
}
