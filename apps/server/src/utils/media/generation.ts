import { t, translateMessage } from "@/lib/i18n";
import { mkdir, readFile, realpath, stat, unlink } from "@toonflow/file";
import { join, relative } from "node:path";
import { mediaProviders, type Provider } from "@toonflow/providers";
import qwenImageSource from "@toonflow/providers/media/qwenImage" with { type: "text" };
import sulphurSource from "@toonflow/providers/media/sulphur" with { type: "text" };
import minimaxH3Source from "@toonflow/providers/media/minimaxH3" with { type: "text" };
import lustifySource from "@toonflow/providers/media/lustify" with { type: "text" };
import wanRemixSource from "@toonflow/providers/media/wanRemix" with { type: "text" };
import fishAudioSource from "@toonflow/providers/media/fishAudio" with { type: "text" };
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import { findOnScreenText } from "@toonflow/tools-scaffold/onScreenText";
import conf from "@/utils/conf";
import { loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { reserveGeneration } from "@/utils/media/usage";

const maxMediaSize = 100 * 1024 * 1024;
// Bun loads these as source text; TypeScript resolves their provider object exports.
const productionModels = {
  image: [
    { provider: "qwenImage", models: ["qwen_image_2_1", "qwen_image_2_1_depth", "qwen_image_2_1_pose"], source: qwenImageSource as unknown as string },
    { provider: "lustify", models: ["lustify_v10_krea2"], source: lustifySource as unknown as string },
  ],
  video: [
    { provider: "sulphur", models: ["sulphur_2", "sulphur_2_base", "tenstrip_10eros_v5"], source: sulphurSource as unknown as string },
    { provider: "minimaxH3", models: ["minimax_h3_i2va", "minimax_h3_ref2va"], source: minimaxH3Source as unknown as string },
    { provider: "wanRemix", models: ["wan22_remix_v3", "wan22_remix_v3_reveal_penis"], source: wanRemixSource as unknown as string },
  ],
  audio: [{ provider: "fishAudio", models: ["drama-3"], source: fishAudioSource as unknown as string }],
};

function productionModel(type: "image" | "video" | "audio", provider: string, model: string) {
  return productionModels[type].find(item => item.provider === provider && item.models.some(id => id === model));
}
export const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export function listMediaModels(): Promise<MediaModel[]> {
  return Promise.resolve((mediaProviders as readonly Provider[]).flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    if (!productionModel(model.type, provider.id, model.id)) return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
        ...(typeof model.character === "string" && /^[\w-]{1,64}$/.test(model.character) ? { character: model.character } : {}),
      } : {}),
    } as MediaModel];
  })));
}

function detectMimeType(bytes: Uint8Array, fallback: string) {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const text = header.toString("ascii");
  const mimeType = fallback.split(";")[0].trim().toLowerCase();
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("fLaC")) return "audio/flac";
  if (text.startsWith("OggS")) return mimeType.startsWith("video/") ? "video/ogg" : mimeType === "audio/opus" ? "audio/opus" : "audio/ogg";
  if (header[0] === 0xff && (header[1]! & 0xf6) === 0xf0) return "audio/aac";
  if (text.startsWith("ID3") || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0 && (header[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (text.slice(4, 8) === "ftyp") {
    if (/avif|avis/.test(text.slice(8))) return "image/avif";
    if (/^M4[AB] $/.test(text.slice(8, 12)) || mimeType.startsWith("audio/")) return "audio/mp4";
    return text.slice(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return mimeType.startsWith("audio/") ? "audio/webm" : "video/webm";
  return ({ "image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-flac": "audio/flac" } as Record<string, string>)[mimeType] ?? mimeType;
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("Reference media must be a file no larger than 100 MB");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("Reference media is empty or exceeds 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(t`The reference media type must be ${mediaType}`);
  return { type: "base64", data: bytes.toString("base64"), mimeType, name: reference.path };
}

// LoRA files are a few hundred MB at most; a safetensors file starts with its header length and a JSON object.
const maxLoraSize = 1024 * 1024 * 1024;

async function readLora(cwd: string, reference: { path: string; strength?: number }, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!reference.path.toLowerCase().endsWith(".safetensors")) invalid("A LoRA must be a .safetensors file");
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxLoraSize) invalid("A LoRA must be a file no larger than 1 GB");
  const bytes = await readFile(path, { signal });
  if (bytes.length < 9 || bytes[8] !== 0x7b) invalid("The LoRA file is not a valid safetensors file");
  const file: Extract<MediaInput, { type: "binary" }> = { type: "binary", data: bytes, mimeType: "application/octet-stream", name: reference.path };
  return { file, strength: reference.strength ?? 1 };
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  if (!/^https?:\/\//i.test(url)) invalid("Generated results must use HTTP or HTTPS URLs");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(t`Failed to download generated results (HTTP ${response.status})`);
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("The generated file cannot exceed 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("The generation result is empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMediaSize) invalid("The generated file cannot exceed 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("Incorrect media type returned by provider");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    const responseMimeType = result.mimeType.split(";")[0].trim().toLowerCase();
    mimeType = responseMimeType && responseMimeType !== "application/octet-stream" ? result.mimeType : mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("The base64 content of the generated result is invalid or exceeds 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("The provider returned an invalid media result"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("The generated file is empty or exceeds 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("The generated result is not in a supported image, video or audio format");
  return { bytes, mimeType };
}

export async function generateMedia(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  if (!productionModel(mediaType, request.providerId, request.modelId)) invalid("This production uses the B3 image, speech and video models only");
  if (!request.prompt.trim()) invalid("Enter a generation prompt");
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  await resolveWorkspacePath(directory, outputDirectory, true);
  const providerInfo = { ...(mediaProviders as readonly Provider[]).find(item => item.id === request.providerId)!, source: productionModel(mediaType, request.providerId, request.modelId)!.source };
  const model = providerInfo.models.find(model => model.id === request.modelId && model.type === mediaType);
  if (!model) invalid("The selected media model does not exist or the type does not match, please select again.");
  const hasPrevisReference = request.previsVideo && request.videos?.some(video => video.path === request.previsVideo!.path && video.mimeType === request.previsVideo!.mimeType);
  if (request.previsVideo && !hasPrevisReference) invalid("The previs blocking reference must be connected in videos");
  if (mediaType === "video" && !(request.mode === "videoControl" && request.videos?.length) && !hasPrevisReference && request.skipPrevis !== true) invalid("Video generation needs a previs blocking reference or depth control video. Skip it only with the user's explicit consent.");
  const onScreenText = mediaType === "audio" || request.skipTextCheck ? [] : findOnScreenText(request.prompt);
  if (onScreenText.length) invalid(`The prompt asks the model to render on-screen text (${onScreenText.join(", ")}); add captions, title cards and signs in post-production, or confirm sending it anyway`);
  if (request.characterId && (mediaType !== "image" || typeof model.character !== "string")) invalid("The selected model does not support character identities. Use an image model that does.");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const provider = await loadMediaProviderSource(providerInfo.source, record(configurations[providerInfo.id]), signal, undefined, directory);
  const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
  if (typeof generate !== "function") invalid(t`This provider does not support ${translateMessage({ image: "Image", video: "Video", audio: "Audio" }[mediaType])} generation`);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) invalid("Please configure the provider API Key in the media model settings first");
  const references = async (items: MediaReference[] | undefined, type: string) => items ? Promise.all(items.map(item => readReference(directory, item, type, signal))) : undefined;
  const images = await references(request.images, "image");
  const loras = request.loras ? await Promise.all(request.loras.map(item => readLora(directory, item, signal))) : undefined;
  const videos = await references(request.videos, "video");
  const audios = await references(request.audios, "audio");
  const speechReferences = audios?.map((audio, index) => ({ ...audio, text: request.audios?.[index]?.text }));
  const firstFrame = request.firstFrame ? await readReference(directory, request.firstFrame, "image", signal) : undefined;
  const lastFrame = request.lastFrame ? await readReference(directory, request.lastFrame, "image", signal) : undefined;
  const initImage = request.initImage ? await readReference(directory, request.initImage, "image", signal) : undefined;
  const mask = request.mask ? await readReference(directory, request.mask, "image", signal) : undefined;
  signal?.throwIfAborted();
  await reserveGeneration(providerInfo.id);
  const assets = mediaType === "audio"
    ? await provider.generateAudio!({
      model: request.modelId, text: request.prompt, images, audios: speechReferences,
      voice: request.voice, emotion: request.emotion, speed: request.speed, volume: request.volume, pitch: request.pitch, language: request.language, format: request.format, sampleRate: request.sampleRate, duration: request.duration,
    })
    : mediaType === "image"
    ? await provider.generateImage!({
      model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size, characterId: request.characterId, loras, seed: request.seed,
      initImage, denoise: request.denoise, mask,
    })
    : await provider.generateVideo!({
      model: request.modelId, prompt: request.prompt, images,
      videos, audios, firstFrame, lastFrame,
      loras,
      ratio: request.ratio, resolution: request.resolution, duration: request.duration,
      generateAudio: request.generateAudio, mode: request.mode, seed: request.seed, parts: request.parts,
    });
  if (!Array.isArray(assets) || !assets.length) invalid("The provider did not return any generation results");
  const written: string[] = [];
  const result: GeneratedMedia[] = [];
  try {
    for (const asset of assets) {
      signal?.throwIfAborted();
      const { bytes, mimeType } = await assetBytes(asset, mediaType, signal);
      signal?.throwIfAborted();
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      const file = join(outputDirectory, `${mediaType}${crypto.randomUUID()}.${mediaExtensions[mimeType]}`);
      // Only the new file is locked: generations finishing together in one folder have unique names and never
      // collide, while a rename or delete of the folder itself still conflicts with the lock.
      const release = lockWorkspaceFiles([(await resolveWorkspacePath(directory, file, true)).path]);
      try {
        await mkdir(output.path, { recursive: true });
        const { path } = await resolveWorkspacePath(directory, file);
        signal?.throwIfAborted();
        await writeWorkspaceFile(path, bytes, true);
        written.push(path);
        result.push({ path: relative(directory, path).replace(/\\/g, "/"), mimeType, mediaType, ...typeof asset.seed === "number" ? { seed: asset.seed } : {} });
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // ACT: Only roll back files created in this run, keeping existing node assets in the directory.
    await Promise.all(written.map(path => unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
    throw err;
  }
}
