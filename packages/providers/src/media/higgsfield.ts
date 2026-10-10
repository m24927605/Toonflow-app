const rules = [] as const;

const version = "1.0.0";

export default {
  id: "higgsfield" as const,
  label: "Higgsfield",
  version,
  readme: "Generates videos with the Higgsfield CLI installed on the computer running Toonflow.\n\n1. Install the CLI: `npm install -g @higgsfield/cli`\n2. Sign in once: `higgsfield auth login`\n\nJobs use the credits of your Higgsfield plan. Toonflow never reads or forwards the CLI credentials.",
  rules,
  models: [
    {
      id: "seedance_2_0",
      label: "Seedance 2.0",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "720p", "1080p"] }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const params: Record<string, string | number | boolean> = {};
    if (request.duration !== undefined) params.duration = request.duration;
    if (request.ratio) params.aspect_ratio = request.ratio;
    if (request.resolution) params.resolution = request.resolution;
    if (typeof request.generateAudio === "boolean") params.generate_audio = request.generateAudio;
    const { url } = await this.tool.higgsfield({
      jobType: request.model,
      prompt: request.prompt,
      params,
      media: {
        "start-image": request.firstFrame ? [request.firstFrame] : [],
        "end-image": request.lastFrame ? [request.lastFrame] : [],
        "image-references": request.images ?? [],
        "video-references": request.videos ?? [],
        "audio-references": request.audios ?? [],
      },
    });
    return [{ mediaType: "video", type: "url", url }];
  },
} satisfies ProviderDefinition<typeof rules>;
