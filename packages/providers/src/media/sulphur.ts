const rules = [] as const;

const version = "1.0.0";

export default {
  id: "sulphur" as const,
  label: "Sulphur 2 B3 (Colab)",
  version,
  readme: "Generates videos with sound using Sulphur 2, an uncensored fine-tune of Lightricks LTX-2.3 22B, on a Colab A100, as Sulphur's own distilled ComfyUI workflows do, on the full Sulphur dev bf16 model the model card offers in place of the LTX-2.3 dev fp8 checkpoint with the Sulphur LoRA (the model character LoRAs are trained on): the distill LoRA and SageAttention, eight steps at half size, then the x2 latent upscaler and three refining steps, with the Gemma 3 12B fp4 text encoder. Canvas nodes and automatic production use this same recipe. Sulphur 2 · B3 base runs Sulphur's base workflows on the same model instead: fifty steps at CFG 3.6 without the distill LoRA at half size, then five refining steps, about three times slower. Sulphur 2 · 10Eros runs the distilled workflows on TenStrip's 10Eros v1.5 merge of Sulphur 2, which Sulphur's model card recommends for image to video; its licence is not stated.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nModels are prepared on demand and reused while production is active. When a Toonflow page is open, completed jobs retain existing sessions until one hour without video production. Active jobs are never stopped by the idle timer; closing all pages restores normal idle cleanup. Jobs use the compute units of your Colab plan.\n\nSulphur 2 takes no reference images: the look of a clip comes from its prompt, its first frame and LoRAs. Write the prompt as Sulphur's own captions are written: one English paragraph in the present tense that opens with the style and camera (\"In this photorealistic live-action video, the camera ...\"), introduces each person, then describes every movement, line and sound in the order it happens, and ends with \"There are no watermarks present in the video.\" Spoken words go in quotation marks after the speaker, their delivery and language. In the first/last frame modes the connected images are pinned as the first and last frames of the clip. In the video control mode, connect a depth, pose or edge video (such as the Director's Studio depth export) as the only video: the LTX-2.3 IC-LoRA Union Control drives camera, blocking and motion from it while the prompt and connected first/last frames decide the look. Connect one audio clip to lock it as the clip's soundtrack: the picture, mouths included, is drawn to that exact sound and the clip keeps the original file, so keep Generate audio on. Character LoRAs trained in Toonflow are uploaded with the job; the prompt names each person by its trigger word. A clip is 1 to 20 seconds long.\n\nThe Colab CLI writes its sign-in tokens to `~/.config/colab-cli/colab.log` in plain text, so Toonflow points that log at the null device before each job and refuses to run while a regular log file exists. Toonflow never reads or forwards the Colab credentials.",
  rules,
  models: [
    {
      id: "sulphur_2",
      label: "Sulphur 2 · B3",
      type: "video",
      // One audio clip is the locked soundtrack; images are only ever first and last frames.
      mode: ["text", ["audioReference:1"], "endFrameOptional", "startFrameOptional", "videoControl"],
      audio: "optional",
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      // Sulphur's distilled workflows on TenStrip's 10Eros merge, which Sulphur recommends for image to video.
      id: "sulphur_2_10eros",
      label: "Sulphur 2 · 10Eros",
      type: "video",
      mode: ["text", ["audioReference:1"], "endFrameOptional", "startFrameOptional", "videoControl"],
      audio: "optional",
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], resolution: ["480p", "720p", "1080p"] }],
    },
    {
      // Sulphur's base workflows: fifty steps at CFG 3.6, slower than the distilled ones.
      id: "sulphur_2_base",
      label: "Sulphur 2 · B3 base",
      type: "video",
      mode: ["text", ["audioReference:1"], "endFrameOptional", "startFrameOptional", "videoControl"],
      audio: "optional",
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], resolution: ["480p", "720p", "1080p"] }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const [soundtrack, ...extra] = request.audios ?? [];
    if (extra.length) throw new Error("Sulphur 2 locks one soundtrack; connect a single audio clip");
    if (request.images?.length) throw new Error("Sulphur 2 takes no reference images; connect images as the first or last frame");
    const videos = request.videos ?? [];
    if (request.mode === "videoControl" ? videos.length !== 1 : videos.length) throw new Error("Sulphur 2 takes one video, as the control video of the video control mode");
    const { data, mimeType, seed } = await this.tool.sulphur({
      prompt: request.prompt,
      parts: request.parts,
      firstFrame: request.firstFrame,
      lastFrame: request.lastFrame,
      controlVideo: request.mode === "videoControl" ? videos[0] : undefined,
      soundtrack,
      loras: request.loras,
      duration: request.duration ?? 5,
      resolution: (request.resolution ?? "720p") as "480p" | "720p" | "1080p",
      ratio: request.ratio ?? "16:9",
      audio: request.generateAudio !== false,
      seed: request.seed,
      workflow: request.model === "sulphur_2_base" ? "base" : "distilled",
      checkpoint: request.model === "sulphur_2_10eros" ? "10eros" : "sulphur",
    });
    return [{ mediaType: "video", type: "binary", data, mimeType, seed }];
  },
} satisfies ProviderDefinition<typeof rules>;
