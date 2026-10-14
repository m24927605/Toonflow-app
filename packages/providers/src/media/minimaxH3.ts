const rules = [] as const;

const version = "1.3.1";

export default {
  id: "minimaxH3" as const,
  label: "MiniMax H3 (Colab)",
  version,
  readme: "Generates videos with sound using the open-weight MiniMax H3 model on a Google Colab A100, through the Colab CLI installed on the computer running Toonflow.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nEach video starts a fresh A100 session, installs ComfyUI and downloads the model (about 10 minutes at 480p or 720p, about 35 minutes at 1080p), then stops the session. Jobs use the compute units of your Colab plan.\n\n1080p renders at 768p and refines an upscaled copy with a second pass, which sharpens detail but may change small details. Refer to connected reference images in the prompt as `<Picture 1>`, `<Picture 2>` and so on, reference videos as `<Video 1>` to `<Video 3>` and reference audio as `<Audio 1>` to `<Audio 3>`, in connection order. To lip-sync a dubbed line, connect its audio and mark it `fully_copy` in the prompt (for example `<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the complete final audio track`, with the speaker saying the same words in time with <Audio 1>) and keep Generate audio on; the clip becomes the soundtrack and the mouth follows it, roughly but not syllable-exact: pauses may not close the mouth. Marked `reference` instead, only the voice timbre and delivery are followed. Reference videos also pass on their look: a grey-box previs connected as one must be named in the prompt as a blocking-only guide (where people stand and move, their relative positions, timing and the camera) whose shapes, materials and colours are not used, as Prepare videos writes it, and it combines with the first/last frame modes. In the control video mode, connect the Director's Studio depth export as the only video and it drives camera, blocking and motion through the Fun ControlNet Union 2.0 while reference images and the prompt decide the look (adds a 4.5–8.4 GB download per session). In the first/last frame modes the connected images are pinned as the first and last frames of the clip. Character LoRAs trained in Toonflow are uploaded with the job and chained after the Turbo LoRA; the prompt names each person by its trigger word.\n\nThe Colab CLI writes its sign-in tokens to `~/.config/colab-cli/colab.log` in plain text, so Toonflow points that log at the null device before each job and refuses to run while a regular log file exists. Toonflow never reads or forwards the Colab credentials.",
  rules,
  models: [
    {
      id: "minimax_h3_ref2va",
      label: "MiniMax H3",
      type: "video",
      // ComfyUI's Ref2VA node accepts at most 9 reference images, 3 reference videos and 3 reference audio clips; frames
      // are pinned with H3 guides.
      mode: ["text", ["imageReference:9", "videoReference:3", "audioReference:3"], "videoControl", "endFrameOptional", "startFrameOptional"],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const { data, mimeType } = await this.tool.minimaxH3({
      prompt: request.prompt,
      // In the frame modes the node still labels its images <Picture N> in connection order, so the pinned frames are
      // also sent as those references; without them the labels point at nothing and the first frame does not hold.
      images: request.images ?? [request.firstFrame, request.lastFrame].filter(frame => frame !== undefined),
      audios: request.audios ?? [],
      videos: request.mode === "videoControl" ? [] : request.videos ?? [],
      controlVideo: request.mode === "videoControl" ? request.videos?.[0] : undefined,
      firstFrame: request.firstFrame,
      lastFrame: request.lastFrame,
      loras: request.loras,
      duration: request.duration ?? 5,
      resolution: (request.resolution ?? "720p") as "480p" | "720p" | "1080p",
      ratio: request.ratio ?? "16:9",
      audio: request.generateAudio !== false,
    });
    return [{ mediaType: "video", type: "binary", data, mimeType }];
  },
} satisfies ProviderDefinition<typeof rules>;
