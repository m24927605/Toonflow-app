import type { ProviderTools } from "@toonflow/providers";
import { inputBytes, inputExtension, randomSeed, runColabJob } from "@/utils/media/colab";
import pipeline from "./minimaxH3Colab.py" with { type: "text" };

export type MinimaxH3Request = Parameters<ProviderTools["minimaxH3"]>[0];

const resolutions = new Set(["480p", "720p", "1080p"]);

/** Renders one MiniMax H3 video on Colab and returns the MP4 bytes. */
export async function runMinimaxH3({ prompt, images = [], duration, resolution, ratio, audio }: MinimaxH3Request, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("MiniMax H3 提示词不能为空");
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("MiniMax H3 时长须为 4 到 15 秒的整数");
  if (!resolutions.has(resolution)) throw new Error("MiniMax H3 只支持 480p、720p 和 1080p");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("MiniMax H3 画面比例无效");
  if (images.length > 9) throw new Error("MiniMax H3 最多支持 9 张参考图片");
  const [video] = await runColabJob({
    script: pipeline,
    uploads: [
      { name: "h3in_prompt.txt", data: prompt },
      ...images.map((image, index) => ({ name: `h3in_ref_${index}.${inputExtension(image)}`, data: inputBytes(image) })),
    ],
    env: { H3_SEED: randomSeed(), H3_RESOLUTION: resolution, H3_RATIO: ratio, H3_DURATION: duration, H3_AUDIO: audio ? 1 : 0 },
    outputs: ["/content/h3out/final.mp4"],
  }, signal);
  return { data: video!, mimeType: "video/mp4" as const };
}
