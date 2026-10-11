import type { ProviderTools } from "@toonflow/providers";
import { inputBytes, inputExtension, randomSeed, runColabJob } from "@/utils/media/colab";
import pipeline from "./minimaxH3Colab.py" with { type: "text" };

export type MinimaxH3Request = Parameters<ProviderTools["minimaxH3"]>[0];

const resolutions = new Set(["480p", "720p", "1080p"]);

/** Renders one MiniMax H3 video on Colab and returns the MP4 bytes. */
export async function runMinimaxH3({ prompt, images = [], videos = [], controlVideo, firstFrame, lastFrame, duration, resolution, ratio, audio }: MinimaxH3Request, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("MiniMax H3 prompt cannot be empty");
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("MiniMax H3 duration must be a whole number of seconds from 4 to 15");
  if (!resolutions.has(resolution)) throw new Error("MiniMax H3 only supports 480p, 720p and 1080p");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("Invalid MiniMax H3 aspect ratio");
  if (images.length > 9) throw new Error("MiniMax H3 supports at most 9 reference images");
  if (videos.length > 3) throw new Error("MiniMax H3 supports at most 3 reference videos");
  const [video] = await runColabJob({
    provider: "minimaxH3",
    script: pipeline,
    uploads: [
      { name: "h3in_prompt.txt", data: prompt },
      ...images.map((image, index) => ({ name: `h3in_ref_${index}.${inputExtension(image)}`, data: inputBytes(image) })),
      ...videos.map((video, index) => ({ name: `h3in_vid_${index}.${inputExtension(video)}`, data: inputBytes(video) })),
      ...controlVideo ? [{ name: `h3in_control.${inputExtension(controlVideo)}`, data: inputBytes(controlVideo) }] : [],
      ...firstFrame ? [{ name: `h3in_first.${inputExtension(firstFrame)}`, data: inputBytes(firstFrame) }] : [],
      ...lastFrame ? [{ name: `h3in_last.${inputExtension(lastFrame)}`, data: inputBytes(lastFrame) }] : [],
    ],
    env: { H3_SEED: randomSeed(), H3_RESOLUTION: resolution, H3_RATIO: ratio, H3_DURATION: duration, H3_AUDIO: audio ? 1 : 0 },
    outputs: ["/content/h3out/final.mp4"],
  }, signal);
  return { data: video!, mimeType: "video/mp4" as const };
}
