import type { ProviderTools } from "@toonflow/providers";
import { inputBytes, inputExtension, randomSeed, runColabJob } from "@/utils/media/colab";
import pipeline from "./qwenImageColab.py" with { type: "text" };

export type QwenImageRequest = Parameters<ProviderTools["qwenImage"]>[0];

/** Draws one Qwen-Image 2.1 Turbo image on Colab and returns the PNG bytes. */
export async function runQwenImage({ prompt, images = [], ratio, size }: QwenImageRequest, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("Qwen-Image 提示词不能为空");
  if (size !== "1K" && size !== "2K") throw new Error("Qwen-Image 只支持 1K 和 2K");
  if (!/^[1-9]\d?:[1-9]\d?$/.test(ratio)) throw new Error("Qwen-Image 画面比例无效");
  if (images.length > 16) throw new Error("Qwen-Image 最多支持 16 张参考图片");
  const [image] = await runColabJob({
    script: pipeline,
    uploads: [
      { name: "qwin_prompt.txt", data: prompt },
      ...images.map((input, index) => ({ name: `qwin_ref_${index}.${inputExtension(input)}`, data: inputBytes(input) })),
    ],
    env: { QW_SEED: randomSeed(), QW_SIZE: size, QW_RATIO: ratio },
    outputs: ["/content/qwout/image.png"],
  }, signal);
  return { data: image!, mimeType: "image/png" as const };
}
