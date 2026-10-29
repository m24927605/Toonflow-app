import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import { createColabWorker } from "./colabPool";
import { inputBytes, inputExtension, randomSeed } from "@/utils/media/colab";
import pipeline from "./minimaxH3Colab.py" with { type: "text" };
import i2vWorkflow from "./minimaxH3I2vWorkflow.json";
import r2vWorkflow from "./minimaxH3R2vWorkflow.json";

export type MinimaxH3Request = Parameters<ProviderTools["minimaxH3"]>[0];

// The aspect ratios the templates' Resolution Selector offers.
const aspects = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "3:2", "2:3"]);
// Lane 2: H3 keeps its own machine, apart from the image and explicit video models.
const worker = createColabWorker("minimaxH3", 2);

/** Renders one MiniMax H3 clip on Colab through the official ComfyUI template for its mode and returns the MP4 bytes. */
export async function runMinimaxH3({ mode, prompt, images, duration, ratio, seed = randomSeed() }: MinimaxH3Request, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("The MiniMax H3 prompt cannot be empty");
  if (mode === "i2v" ? images.length !== 1 : images.length < 1 || images.length > 9) throw new Error(mode === "i2v" ? "MiniMax H3 I2VA takes one first frame" : "MiniMax H3 Ref2VA takes 1 to 9 reference images");
  if (!Number.isInteger(duration) || duration < 2 || duration > 15) throw new Error("MiniMax H3 renders whole seconds from 2 to 15");
  if (!aspects.has(ratio)) throw new Error(`MiniMax H3 templates offer no ${ratio} aspect ratio`);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid MiniMax H3 seed");
  const job = crypto.randomUUID().slice(0, 8);
  const name = (rest: string) => `h3in_${job}_${rest}`;
  const video = await worker.run(async (session, sessionSignal) => {
    const [output, timings] = await session.job({
      script: pipeline,
      uploads: [
        { name: name("prompt.txt"), data: prompt },
        ...images.map((image, index) => ({ name: name(`image_${index}.${inputExtension(image)}`), data: inputBytes(image) })),
        { name: name("workflow.json"), data: JSON.stringify(mode === "i2v" ? i2vWorkflow : r2vWorkflow) },
      ],
      env: { H3_JOB: job, H3_MODE: mode, H3_SEED: seed, H3_DURATION: duration, H3_RATIO: ratio },
      outputs: [`/content/h3Out/${job}/final.mp4`, `/content/h3Out/${job}/timings.json`],
    }, sessionSignal);
    const report = JSON.parse(new TextDecoder().decode(timings)) as { artifact: { bytes: number; sha256: string } };
    // The seconds each phase of the job took on the machine, for finding the slow ones.
    console.log(`[minimaxH3] Job ${job} timings: ${JSON.stringify(report)}`);
    if (report.artifact.bytes !== output!.length || createHash("sha256").update(output!).digest("hex") !== report.artifact.sha256) throw new Error("MiniMax H3 clip digest mismatch");
    return output!;
  }, signal);
  return { data: video, mimeType: "video/mp4" as const, seed };
}
