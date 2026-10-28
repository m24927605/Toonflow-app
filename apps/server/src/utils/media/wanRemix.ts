import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { colabLane, colabPoolRestored, colabSessionName, createColabWorker } from "./colabPool";
import { inputBytes, inputExtension, randomSeed } from "@/utils/media/colab";
import pipeline from "./wanRemixColab.py" with { type: "text" };
import template from "./wanRemixPrompt.json";

export type WanRemixRequest = Parameters<ProviderTools["wanRemix"]>[0];

// Wan 2.2 renders 16 fps clips of 4n+1 frames; five seconds is the 81 frames of one render, and a longer clip chains
// renders with SVI 2.0 Pro, tested and approved up to 15 seconds.
const fps = 16;
const renderSeconds = 5;
export const maxWanRemixSeconds = 15;
// 720p, the size the approved clips were rendered at (1280x720 for 16:9), on Wan's 16-pixel grid.
const shortSide = 720;
// The A100 lanes outside the speech lane, preferring one with a running machine, as 10Eros V5 picks them.
const lanes = [1, 3];
const workers = lanes.map(lane => createColabWorker("wanRemix", lane));
const waiting = workers.map(() => 0);

/** The width and height for an aspect ratio such as 16:9. */
function wanRemixSize(ratio: string) {
  const [ratioWidth, ratioHeight] = ratio.split(":").map(Number) as [number, number];
  const long = Math.round(shortSide * Math.max(ratioWidth, ratioHeight) / Math.min(ratioWidth, ratioHeight) / 16) * 16;
  return ratioWidth >= ratioHeight ? { width: long, height: shortSide } : { width: shortSide, height: long };
}

/**
 * Renders one Wan 2.2 Remix V3 clip on Colab from a start image, and an end image if given (one render only); a clip
 * longer than one render is chained with SVI 2.0 Pro. Returns the MP4 bytes.
 */
export async function runWanRemix({ prompt, firstFrame, lastFrame, duration, ratio, revealPenis, seed = randomSeed() }: WanRemixRequest, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("The Wan Remix prompt cannot be empty");
  if (!Number.isInteger(duration) || duration < 1 || duration > maxWanRemixSeconds) throw new Error(`Wan Remix renders whole seconds from 1 to ${maxWanRemixSeconds}`);
  if (lastFrame && duration > renderSeconds) throw new Error(`An end frame pins one Wan Remix render of at most ${renderSeconds} seconds`);
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("Invalid Wan Remix aspect ratio");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid Wan Remix seed");
  const { width, height } = wanRemixSize(ratio);
  const job = crypto.randomUUID().slice(0, 8);
  const name = (rest: string) => `wanremixin_${job}_${rest}`;
  await colabPoolRestored();
  const rank = (index: number) => (colabSessionName(colabLane(lanes[index]!)) ? 0 : 100) + waiting[index]!;
  const index = workers.map((_, index) => index).reduce((best, index) => rank(index) < rank(best) ? index : best);
  waiting[index]!++;
  const video = await workers[index]!.run(async (session, sessionSignal) => {
    const [output, timings] = await session.job({
      script: pipeline,
      uploads: [
        { name: name("prompt.txt"), data: prompt },
        { name: name("template.json"), data: JSON.stringify(template) },
        { name: name(`first.${inputExtension(firstFrame)}`), data: inputBytes(firstFrame) },
        ...lastFrame ? [{ name: name(`last.${inputExtension(lastFrame)}`), data: inputBytes(lastFrame) }] : [],
      ],
      env: { WANREMIX_JOB: job, WANREMIX_SEED: seed, WANREMIX_WIDTH: width, WANREMIX_HEIGHT: height, WANREMIX_FRAMES: duration * fps + 1, WANREMIX_REVEAL: revealPenis ? 1 : 0 },
      outputs: [`/content/wanRemixOut/${job}/final.mp4`, `/content/wanRemixOut/${job}/timings.json`],
    }, sessionSignal);
    const report = JSON.parse(new TextDecoder().decode(timings)) as { artifact: { bytes: number; sha256: string } };
    // The seconds each phase of the job took on the machine, for finding the slow ones.
    console.log(`[wanRemix] Job ${job} timings: ${JSON.stringify(report)}`);
    if (report.artifact.bytes !== output!.length || createHash("sha256").update(output!).digest("hex") !== report.artifact.sha256) throw new Error("Wan Remix clip digest mismatch");
    return output!;
  }, signal).finally(() => waiting[index]!--);
  return { data: video, mimeType: "video/mp4" as const, seed };
}
