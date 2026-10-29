/// <reference types="bun" />

type ModelType = "text" | "image" | "video" | "audio";

type ImageMode = "text" | "singleImage" | "multiReference";
type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  /** Continues the single video in `videos` forward by `duration` seconds; reference images still guide the result. */
  | "videoExtension"
  /** Uses the single video in `videos` as a structure control (depth, pose or edges) instead of a look reference; images stay look references. */
  | "videoControl"
  | (`${"video" | "image" | "audio"}Reference:${number}`)[];

interface ProviderModel {
  id: string;
  label: string;
  type: ModelType;
  contextWindow?: number;
  maxOutputTokens?: number;
  think?: boolean;
  mode?: (ImageMode | VideoMode)[];
  associationSkills?: string;
  audio?: "optional" | boolean;
  imageSizes?: string[];
  imageRatios?: string[];
  durationResolutionMap?: { duration: number[]; resolution: string[] }[];
  voices?: { title: string; voice: string }[];
  /** Kind of trained character identity an image model accepts, e.g. `soul_2`; matched against the identity's kind. */
  character?: string;
}

interface ProviderFormRule {
  field: string;
  value: unknown;
}

type ProviderConfig<TRules extends readonly ProviderFormRule[]> = {
  [TRule in TRules[number] as TRule["field"]]: TRule["value"];
};

interface ProviderContext<TConfig = Record<string, unknown>> {
  config: TConfig;
  signal?: AbortSignal;
  /**
   * Tools injected directly by the host, so providers need no imports;
   * FFmpeg is a plugin capability installed on demand.
   */
  tool: ProviderTools;
}

interface MediaRequest {
  model: string;
  /** Provider-specific parameters only; providers validate the mapping and supported range of common fields. */
  other?: Record<string, unknown>;
}

/** Media source in the abstraction layer; providers convert it to the URL, file or bytes the platform needs. */
type MediaInput =
  | { type: "url"; url: string; mimeType?: string; name?: string }
  | { type: "base64"; data: string; mimeType: string; name?: string }
  | { type: "binary"; data: Uint8Array; mimeType: string; name?: string };

/** A generated result; `seed` is the seed the model drew with, for models that report one. */
type MediaAsset = MediaInput & { mediaType: "image" | "video" | "audio"; seed?: number };

type MediaImageInfo = { width: number; height: number; format: string };
type MediaImageResizeOptions = { width?: number; height?: number; format?: "jpeg" | "png" | "webp"; quality?: number };

interface AudioConvertOptions {
  format: "wav" | "mp3";
  /** Trim start in seconds, inclusive; defaults to 0. */
  startSeconds?: number;
  /** Trim end in seconds, exclusive; defaults to the end of the audio. */
  endSeconds?: number;
  /** Target sample rate; defaults to the original sample rate. */
  sampleRate?: number;
  /** mp3 bitrate in kbps; defaults to 128 and only applies when format is mp3. */
  bitrateKbps?: number;
}

/**
 * Thrown when no usable FFmpeg is available;
 * the host frontend prompts to download and install it, so providers should rethrow it.
 */
interface FfmpegRequiredError extends Error {
  name: "FfmpegRequiredError";
  code: "FFMPEG_REQUIRED";
  status: 424;
}

interface ProviderTools {
  fetch: typeof globalThis.fetch;
  /** Extracts a readable reason from a provider error body, hiding configured keys and URL query parameters. */
  errorMessage(value: unknown): string;
  hash: typeof Bun.hash;
  image: typeof Bun.Image;
  /**
   * Shared basic image processing tools;
   * providers can use them in processMedia according to their models' capabilities.
   */
  media: {
    inspectImage(input: MediaInput): Promise<MediaImageInfo>;
    resizeImage(input: MediaInput, options: MediaImageResizeOptions): Promise<MediaInput>;
  };
  /**
   * Audio trimming and transcoding; accepts only in-memory WAV bytes and returns processed in-memory bytes.
   * File paths, URLs and other compressed formats are not supported as input.
   */
  audio: {
    convert(input: Uint8Array, options: AudioConvertOptions): Promise<{ data: Uint8Array; mimeType: string }>;
  };
  /** MessagePack encoding for APIs that take binary request bodies; byte arrays become MessagePack bin values. */
  msgpack: {
    encode(value: unknown): Uint8Array<ArrayBuffer>;
  };
  /**
   * Gets the native @renmu/fluent-ffmpeg factory bound to the current workspace,
   * keeping chained calls, events, streams and ffprobe callbacks.
   * Only explicit file paths go through workspace boundary checks;
   * indirect I/O in raw arguments, filters and list files is not sandboxed.
   * The host always injects this entry and checks FFmpeg/FFprobe when called;
   * debug contexts without a working directory cannot use it.
   * Throws FfmpegRequiredError when missing and notifies the online frontend to prompt a download;
   * it never auto-installs in the background.
   * After installation the user retries the operation;
   * providers must not catch this error and automatically retry the full generation request.
   * Output overwrite behavior follows the native library;
   * callers handle file naming, end/error events and cancellation via command.kill.
   * @throws {FfmpegRequiredError} FFmpeg is not installed or no usable FFmpeg is found with the current settings.
   * @example const ffmpeg = await this.tool.ffmpeg(); const command = ffmpeg("assets/input.mp4").videoCodec("libx264");
   */
  ffmpeg(): Promise<import("@toonflow/ffmpeg/types").FfmpegFactory>;
  /**
   * Runs one job with the Higgsfield CLI installed and signed in on the host (`higgsfield generate create <jobType> --wait --json`).
   * `params` are the job type's schema params (`higgsfield model get <jobType>`); media inputs are written to temporary
   * files that the CLI uploads. Resolves with the finished job's result URL. The host never exposes the CLI credentials.
   */
  higgsfield(request: {
    jobType: string;
    prompt: string;
    params?: Record<string, string | number | boolean>;
    media?: Partial<Record<"image-references" | "video-references" | "audio-references" | "start-image" | "end-image", MediaInput[]>>;
  }): Promise<{ url: string }>;
  /**
   * Renders one Sulphur 2 (LTX-2.3) video with sound on a Google Colab A100 through the Colab CLI installed and signed
   * in on the host, using the compute units of that Google account. The host never exposes the Colab credentials.
   */
  sulphur(request: {
    /** One English paragraph in Sulphur's caption format: style and camera, the people, then every movement, line and sound in order. */
    prompt: string;
    /** Image pinned as the first frame. */
    firstFrame?: MediaInput;
    /** Image pinned as the last frame. */
    lastFrame?: MediaInput;
    /** Structure video (depth, pose or edges, e.g. a previs depth pass) applied with the IC-LoRA Union Control; its look is never copied. */
    controlVideo?: MediaInput;
    /** Audio locked as the clip's soundtrack: the picture, mouths included, is drawn to it and the clip keeps the file. */
    soundtrack?: MediaInput;
    /** LoRAs (.safetensors) applied to the model at their strength. */
    loras?: LoraInput[];
    /** Whole seconds, 1–20, or up to 120 for a long take with `parts`. */
    duration: number;
    /**
     * A long take: the prompt of each of its consecutive parts, as many as `longTakeParts` gives for the duration. Each
     * part opens on the last 25 frames of the one before, and they are joined without cuts.
     */
    parts?: string[];
    resolution: "480p" | "720p" | "1080p";
    /** Aspect ratio such as 16:9 or 9:16. */
    ratio: string;
    /** Keeps the generated soundtrack; false returns a silent video. */
    audio: boolean;
    /** Seed to draw with; a random one when left out. */
    seed?: number;
    /** Sulphur's distilled workflows (the default), or its base workflows: fifty steps at CFG 3.6. */
    workflow?: "distilled" | "base";
  }): Promise<{ data: Uint8Array; mimeType: "video/mp4"; seed: number }>;
  /**
   * Renders one clip with TenStrip's 10Eros "Basic I2V DMD V5" ComfyUI workflow on a Google Colab A100, exactly as
   * published but for the start image, prompt, seed, size and length, through the Colab CLI signed in on the host.
   */
  /**
   * Renders one MiniMax H3 clip on a Google Colab A100 through the official ComfyUI template for its mode, exactly as
   * published but for the images, prompt, seed, duration and aspect ratio, through the Colab CLI signed in on the host.
   */
  minimaxH3(request: {
    /** i2v opens on its single image; r2v uses 1–9 reference images as <Picture 1>..<Picture N>. */
    mode: "i2v" | "r2v";
    /** The prompt in MiniMax's official format, used verbatim. */
    prompt: string;
    images: MediaInput[];
    /** Whole seconds, 2–15. */
    duration: number;
    /** Aspect ratio such as 16:9 or 9:16. */
    ratio: string;
    /** Seed to draw with; a random one when left out. */
    seed?: number;
  }): Promise<{ data: Uint8Array; mimeType: "video/mp4"; seed: number }>;
  /**
   * Draws one LUSTIFY v10 (Krea 2) still through Comfy-Org's Krea 2 Turbo template. Character LoRAs, in the
   * left-to-right order the people stand in the frame, are confined to their heads on a second pass.
   */
  lustify(request: {
    /** The prompt, used verbatim; name each locked character by their LoRA trigger. */
    prompt: string;
    /** Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2 or 2:3. */
    ratio: string;
    /** Character LoRAs trained on Krea 2, left to right; their strength is fixed by the lock. */
    loras?: LoraInput[];
    /** Seed to draw with; a random one when left out. */
    seed?: number;
    /** A picture to redraw instead of drawing from noise; it is fitted to the ratio's size. */
    initImage?: MediaInput;
    /** With `initImage`: how much of the redrawn area is drawn anew, above 0 and up to 1. */
    denoise?: number;
    /** With `initImage`: white where the picture is redrawn; without it only the locked heads are redrawn. */
    mask?: MediaInput;
  }): Promise<{ data: Uint8Array; mimeType: "image/png"; seed: number }>;
  erosV5(request: {
    /** The positive prompt, used verbatim. */
    prompt: string;
    /** The start image the clip opens on. */
    firstFrame: MediaInput;
    /** Dubbed audio locked as the clip's soundtrack in both passes; the clip keeps the file. */
    soundtrack?: MediaInput;
    /** Whole seconds, 1–15. */
    duration: number;
    resolution: "480p" | "720p" | "1080p";
    /** Aspect ratio such as 16:9 or 9:16. */
    ratio: string;
    /** Keeps the generated soundtrack; false returns a silent video. */
    audio: boolean;
    /** Seed to draw with; a random one when left out. */
    seed?: number;
  }): Promise<{ data: Uint8Array; mimeType: "video/mp4"; seed: number }>;
  /** Renders one silent 720p, 16 fps Wan 2.2 Remix V3 clip from a start image; past 5 seconds SVI 2.0 Pro chains renders. */
  wanRemix(request: {
    /** The positive prompt, used verbatim. */
    prompt: string;
    /** The start image the clip opens on. */
    firstFrame: MediaInput;
    /** An image the clip ends on; only for clips of up to 5 seconds. */
    lastFrame?: MediaInput;
    /** Whole seconds, 1–15. */
    duration: number;
    /** Aspect ratio such as 16:9 or 9:16. */
    ratio: string;
    /** Loads TenStrip's Reveal Penis LoRA pair on both experts. */
    revealPenis: boolean;
    /** Seed to draw with; a random one when left out. */
    seed?: number;
  }): Promise<{ data: Uint8Array; mimeType: "video/mp4"; seed: number }>;
  /**
   * Draws one Qwen-Image 2.1 image (base model) on a Google Colab A100
   * through the Colab CLI installed and signed in on the
   * host, using the compute units of that Google account. The host gathers the requests made around the same time
   * and draws them in one session, so setup is paid once per batch; it resolves when the batch finishes and the
   * session always stops. The host never exposes the Colab credentials.
   */
  qwenImage(request: {
    prompt: string;
    /** Up to 16 reference images; with references the output follows the first reference's aspect. */
    images?: MediaInput[];
    /** Aspect ratio such as 16:9, used when there are no references. */
    ratio: string;
    /** Pixel area: 1K is about 1024×1024, 2K about 2048×2048. */
    size: "1K" | "2K";
    /** Structure map (a depth map: near white, far black) that fixes the composition and viewpoint through ControlNet. */
    controlImage?: MediaInput;
    /** LoRAs (.safetensors) applied to the model at their strength. */
    loras?: LoraInput[];
    /** Seed to draw with; a random one when left out. */
    seed?: number;
    /** A picture to redraw: the result keeps its composition and changes as much as `denoise` allows. */
    initImage?: MediaInput;
    /** With `initImage`, required: the noise level the redraw starts from, above 0 (kept) up to 1 (drawn anew). */
    denoise?: number;
    /**
     * A special recipe: "pose" puts the person of the second image into the pose of the
     * textureless mannequin render given as the first image.
     */
    recipe?: "pose";
  }): Promise<{ data: Uint8Array; mimeType: "image/png"; seed: number }>;
}

/** A LoRA file and the strength to apply it at. */
interface LoraInput {
  file: MediaInput;
  strength: number;
}

interface ImageRequest extends MediaRequest {
  prompt: string;
  /** Reference images. */
  images?: MediaInput[];
  /** LoRA files for models that load them; other providers ignore them. */
  loras?: LoraInput[];
  mask?: MediaInput;
  /** Number of results to generate. */
  n?: number;
  /** Aspect ratio, e.g. 16:9. */
  ratio?: string;
  /** Output size, e.g. 1K, 2K, 4K or 1024x1024; providers convert the exact format. */
  size?: string;
  /** Quality tier, e.g. low, medium, high; mapped by the provider. */
  quality?: string;
  /** Output encoding format, e.g. png, jpeg, webp. */
  outputFormat?: string;
  /** Trained character identity to keep consistent; only sent to models that declare `character`. */
  characterId?: string;
  /** Seed to draw with, so a rerun that changes one thing keeps the rest; providers without seeds ignore it. */
  seed?: number;
  /** A picture to redraw instead of drawing from noise, for models that redraw an image; others ignore it. */
  initImage?: MediaInput;
  /** With `initImage`: how much of it is redrawn, from 0 (kept) to 1 (drawn anew). */
  denoise?: number;
}

interface VideoRequest extends MediaRequest {
  prompt: string;
  /** Current generation mode; reference mode arrays declare the count limit for each kind of reference media. */
  mode?: VideoMode;
  /** Reference images; first/last frames are passed separately via firstFrame and lastFrame. */
  images?: MediaInput[];
  videos?: MediaInput[];
  audios?: MediaInput[];
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
  /** LoRA files for models that load them; other providers ignore them. */
  loras?: LoraInput[];
  /** Output duration in seconds; providers validate the supported range per model. */
  duration?: number;
  /** Aspect ratio, e.g. 16:9. */
  ratio?: string;
  /** Resolution tier, e.g. 720p, 1080p. */
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  /** Seed to draw with, so a rerun that changes one thing keeps the rest; providers without seeds ignore it. */
  seed?: number;
  /** A take longer than one generation: the prompt of each consecutive part; providers without long takes ignore it. */
  parts?: string[];
}

/**
 * Basic audio generation parameters;
 * at least one of text or prompt is required, and providers handle non-empty validation and model capability checks.
 */
type AudioRequest = MediaRequest & {
  /** Output length in seconds for music and sound creation; empty uses the model default. */
  duration?: number;
  /** Text to read aloud, for text-to-speech. */
  text?: string;
  /** Prompt for audio creation or voice style, which can be passed separately from the text to read. */
  prompt?: string;
  /** Reference audio, optionally with an exact transcript of the clip; providers handle the upload or cloning flow. */
  audios?: (MediaInput & { text?: string })[];
  /**
   * Reference images for audio creation;
   * providers validate per model the count and whether they can be sent with reference audio.
   */
  images?: MediaInput[];
  /** System or cloned voice ID, mapped by the provider to the platform's voice parameter. */
  voice?: string;
  /** Speed multiplier, 1 is normal speed; providers convert it to the platform's speed scale. */
  speed?: number;
  /** Volume gain in dB, 0 is the original volume; providers convert it to the platform's volume scale. */
  volume?: number;
  /**
   * Pitch shift in semitones at the abstraction layer, 0 is the original pitch;
   * providers map it to the platform scale and validate the supported range.
   */
  pitch?: number;
  /** Emotion, e.g. happy, sad, angry; providers map it and validate whether the model and voice support it. */
  emotion?: string;
  /**
   * Synthesis language or dialect, e.g. zh-CN, en, yue;
   * mapped by the provider, defaulting to the model's default behavior.
   */
  language?: string;
  /**
   * Whether to normalize how numbers and similar text are read;
   * providers validate supported languages and rules per model.
   */
  normalizeText?: boolean;
  /** Output encoding format, e.g. mp3, wav, pcm, flac, opus; providers map it to the platform's format name. */
  format?: string;
  /** Output sample rate in Hz. */
  sampleRate?: number;
  /**
   * Output bitrate in kbps;
   * only for formats with a configurable bitrate, converted by the provider to the platform's unit.
   */
  bitrateKbps?: number;
} & ({ text: string } | { prompt: string });

/**
 * All three generate functions return the final media array; they must not return task IDs or raw platform responses.
 * ACT: This layer only defines complete results;
 * providers handle polling/stream reading internally and throw on failure.
 */
type GenerateMedia<TRequest, TConfig = Record<string, unknown>> = (
  this: ProviderContext<TConfig>,
  request: TRequest,
) => Promise<MediaAsset[]>;

interface ProviderUpdateInfo {
  hasUpdate: boolean;
  latestVersion: string;
  notice: string;
}

interface ProviderDefinition<TRules extends readonly ProviderFormRule[] = readonly ProviderFormRule[]> {
  id: string;
  label: string;
  /** Provider brand icon; supports an image URL or a data:image/...;base64,... URI. */
  icon?: string;
  /** Adapter file version, independent of model versions. */
  version: string;
  apiUrl?: string;
  /**
   * GET URL of the media model list;
   * uses the configured apiKey as the Bearer credential and returns { data: <model array> }.
   * Models must include id; type can be filled from the URL's type parameter or an existing model with the same name.
   * An optional modelInfo object provides model capabilities
   * (e.g. mode, audio, durationResolutionMap, imageSizes, imageRatios), merged into the model's top level when fetched.
   * When set, models can be fetched manually.
   */
  modelsUrl?: string;
  protocol?: "openai-completions" | "openai-responses" | "anthropic-messages" | "openai-codex-responses" | "claude-code" | "colab-cli";
  /** Markdown content of the vendor description. */
  readme?: string;
  rules: TRules;
  models: ProviderModel[];
  /** Checks whether the provider adapter file has an update. */
  checkForUpdates?: (this: ProviderContext<ProviderConfig<TRules>>) => Promise<ProviderUpdateInfo>;
  /** Gets the full source of the updated file; the host handles writing and applying it. */
  updateVendor?: (this: ProviderContext<ProviderConfig<TRules>>) => Promise<string>;
  /** Leave unimplemented methods undefined; callers use that to tell whether a capability is available. */
  generateImage?: GenerateMedia<ImageRequest, ProviderConfig<TRules>>;
  generateVideo?: GenerateMedia<VideoRequest, ProviderConfig<TRules>>;
  generateAudio?: GenerateMedia<AudioRequest, ProviderConfig<TRules>>;
  /** Optional provider media preprocessing; the request is unchanged when not implemented. */
  processMedia?: (this: ProviderContext<ProviderConfig<TRules>>, request: ImageRequest | VideoRequest | AudioRequest) => Promise<ImageRequest | VideoRequest | AudioRequest>;
}
