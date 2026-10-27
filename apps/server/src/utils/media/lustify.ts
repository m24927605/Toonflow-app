import { createHash } from "node:crypto";
import type { ProviderTools } from "@toonflow/providers";
import type { ColabSession } from "./colab";
import { createColabWorker } from "./colabPool";
import { inputBytes, randomSeed } from "@/utils/media/colab";
import pipeline from "./lustifyColab.py" with { type: "text" };
import template from "./lustifyPrompt.json";

export type LustifyRequest = Parameters<ProviderTools["lustify"]>[0];

// Sizes near one megapixel on the 16-pixel grid, as Krea 2 was trained; 16:9 is the 1344x768 every test was drawn at.
const sizes: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 }, "16:9": { width: 1344, height: 768 }, "9:16": { width: 768, height: 1344 },
  "4:3": { width: 1152, height: 864 }, "3:4": { width: 864, height: 1152 }, "3:2": { width: 1248, height: 832 }, "2:3": { width: 832, height: 1248 },
};
// The head-box lock verified on two-person frames: each LoRA at 2.5 inside a square 2.4 times the detected face.
const lockStrength = 2.5;
const headScale = 2.4;
const worker = createColabWorker("lustify", 1);
const sentLoras = new WeakMap<ColabSession, Set<string>>();

/**
 * Draws one LUSTIFY v10 (Krea 2) still on Colab. Character LoRAs, listed in the left-to-right order the people stand in
 * the frame, are confined to their heads on a second pass over the same prompt and seed; returns the PNG bytes. Given a
 * picture to redraw, only part of it is redrawn at `denoise`: the white of the mask, or else the heads the LoRAs lock,
 * which brings back faces that drifted in the clip the picture ends.
 */
export async function runLustify({ prompt, ratio, loras = [], seed = randomSeed(), initImage, denoise, mask }: LustifyRequest, signal?: AbortSignal) {
  if (!prompt.trim()) throw new Error("The LUSTIFY prompt cannot be empty");
  const size = sizes[ratio];
  if (!size) throw new Error(`LUSTIFY here draws ${Object.keys(sizes).join(", ")} only`);
  if (loras.length > 4) throw new Error("LUSTIFY locks at most 4 characters in one frame");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("Invalid LUSTIFY seed");
  if (initImage && !(typeof denoise === "number" && denoise > 0 && denoise <= 1)) throw new Error("Redrawing a picture with LUSTIFY needs a denoise above 0 and up to 1");
  if (initImage && !mask && !loras.length) throw new Error("Redrawing with LUSTIFY needs a mask or character LoRAs whose heads it redraws");
  if (mask && !initImage) throw new Error("A LUSTIFY mask needs the picture it marks");
  const files = loras.map(lora => inputBytes(lora.file)).map(data => ({ data, name: `lustifyLora_${createHash("sha256").update(data).digest("hex").slice(0, 32)}.safetensors` }));
  const job = crypto.randomUUID().slice(0, 8);
  const name = (rest: string) => `lustifyin_${job}_${rest}`;
  const image = await worker.run(async (session, sessionSignal) => {
    const sent = sentLoras.get(session) ?? new Set<string>();
    const uploads = [...new Map(files.filter(file => !sent.has(file.name)).map(file => [file.name, file])).values()];
    const [output, timings] = await session.job({
      script: pipeline,
      uploads: [
        { name: name("prompt.txt"), data: prompt },
        { name: name("template.json"), data: JSON.stringify(template) },
        { name: name("loras.json"), data: JSON.stringify(files.map(({ name }) => ({ name }))) },
        ...initImage ? [{ name: name("init.png"), data: inputBytes(initImage) }] : [],
        ...mask ? [{ name: name("mask.png"), data: inputBytes(mask) }] : [],
        ...uploads,
      ],
      env: { LUSTIFY_JOB: job, LUSTIFY_SEED: seed, LUSTIFY_WIDTH: size.width, LUSTIFY_HEIGHT: size.height, LUSTIFY_STRENGTH: lockStrength, LUSTIFY_HEAD_SCALE: headScale, LUSTIFY_DENOISE: initImage ? denoise! : 1 },
      outputs: [`/content/lustifyOut/${job}/final.png`, `/content/lustifyOut/${job}/timings.json`],
    }, sessionSignal);
    for (const { name } of uploads) sent.add(name);
    sentLoras.set(session, sent);
    const report = JSON.parse(new TextDecoder().decode(timings)) as { heads: number; artifact: { bytes: number; sha256: string } };
    // The seconds each phase took and how many heads the lock found.
    console.log(`[lustify] Job ${job} timings: ${JSON.stringify(report)}`);
    if (report.artifact.bytes !== output!.length || createHash("sha256").update(output!).digest("hex") !== report.artifact.sha256) throw new Error("LUSTIFY image digest mismatch");
    return output!;
  }, signal);
  return { data: image, mimeType: "image/png" as const, seed };
}
