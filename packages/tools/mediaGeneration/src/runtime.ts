import { z } from "zod";

export type { MediaModel, MediaReference, MediaGenerationRequest, GeneratedMedia, MediaContext } from "@toonflow/tools-scaffold/runtime";

const relativePath = z.string().min(1).max(2048).refine(
  path => !/^[\\/]|[:\u0000-\u001f]/.test(path) && path.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "Path must be a relative path inside the workspace and cannot contain empty path segments or ..",
);
const imageReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i) });
const videoReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i) });
const audioReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i), text: z.string().trim().min(1).max(100000).optional() });
const sharedFields = {
  providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(100000),
  outputDirectory: relativePath.optional(),
  images: z.array(imageReference).max(64).optional(),
  ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
};
// Image and video models garble readable text; captions, title cards and signs are added in post-production.
const skipTextCheck = z.boolean().describe("Set true only after the user confirmed sending a prompt that asks the model to render on-screen text; otherwise remove the text from the prompt and add it in post-production").optional();
const referenceMode = z.templateLiteral([z.enum(["image", "video", "audio"]), "Reference:", z.number()])
  .refine(value => /Reference:(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])$/.test(value), "Number of references must be between 1 and 256");

export const listMediaModelsSchema = z.strictObject({});
export const imageGenerationSchema = z.strictObject({
  ...sharedFields,
  size: z.string().trim().min(1).max(64).optional(),
  characterId: z.string().regex(/^[\w-]{1,128}$/, "Invalid character identity ID.").optional(),
  loras: z.array(z.strictObject({ path: relativePath, strength: z.number().min(-4).max(4).optional() })).max(4).describe("LoRA files (.safetensors) in the workspace with an optional strength (1 by default; sliders take -4 to 4); the prompt names each by its trigger word").optional(),
  skipTextCheck,
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("The seed of an earlier result, reported with it, to change one thing and keep the rest; omit for a new random seed").optional(),
});
export const videoGenerationSchema = z.strictObject({
  ...sharedFields,
  videos: z.array(videoReference).max(64).optional(),
  previsVideo: videoReference.describe("The previs blocking reference, which must also appear in videos; depth control instead uses videoControl mode").optional(),
  audios: z.array(audioReference).max(64).optional(),
  firstFrame: imageReference.optional(),
  lastFrame: imageReference.optional(),
  loras: z.array(z.strictObject({ path: relativePath, strength: z.number().min(-4).max(4).optional() })).max(4).describe("LoRA files (.safetensors) in the workspace with an optional strength (1 by default; sliders take -4 to 4); the prompt names each by its trigger word").optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  duration: z.number().finite().positive().max(3600).optional(),
  generateAudio: z.boolean().optional(),
  skipTextCheck,
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).describe("The seed of an earlier result, reported with it, to change one thing and keep the rest; omit for a new random seed").optional(),
  parts: z.array(z.string().trim().min(1).max(100000)).min(2).max(12).describe("A long take of consecutive parts joined without cuts: one prompt per part in order; every part after the first continues from the last frames of the one before").optional(),
  skipPrevis: z.boolean().describe("Set true only when the user explicitly agrees to skip previs; otherwise supply previsVideo in videos for blocking, or a depth video in videoControl mode").optional(),
  mode: z.union([
    z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text", "videoExtension", "videoControl"]),
    z.array(referenceMode).min(1).max(3),
  ]).optional(),
});
export const audioGenerationSchema = z.strictObject({
  providerId: sharedFields.providerId,
  modelId: sharedFields.modelId,
  prompt: sharedFields.prompt,
  outputDirectory: sharedFields.outputDirectory,
  images: sharedFields.images,
  audios: z.array(audioReference).max(64).optional(),
  voice: z.string().trim().min(1).max(256).optional(),
  // Free-text delivery such as "low and slow" or "furious shout"; providers that cannot act on it ignore it.
  emotion: z.string().trim().min(1).max(500).optional(),
  speed: z.number().finite().positive().optional(),
  volume: z.number().finite().optional(),
  pitch: z.number().finite().optional(),
  language: z.string().trim().min(1).max(64).optional(),
  format: z.string().trim().min(1).max(64).optional(),
  sampleRate: z.number().int().positive().optional(),
  duration: z.number().int().min(1).max(600).describe("Output duration of the music or sound effect in seconds; uses the model default when omitted").optional(),
});
