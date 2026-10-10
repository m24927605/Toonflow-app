const rules = [] as const;

const version = "1.1.0";

export default {
  id: "higgsfield" as const,
  label: "Higgsfield",
  version,
  readme: "Generates videos with Seedance 2.0 and 2.5 through the Higgsfield CLI installed on the computer running Toonflow.\n\n1. Install the CLI: `npm install -g @higgsfield/cli`\n2. Sign in once: `higgsfield auth login`\n\nJobs use the credits of your Higgsfield plan. Toonflow never reads or forwards the CLI credentials.",
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
    {
      id: "seedance_2_5",
      label: "Seedance 2.5",
      type: "video",
      // Higgsfield allows 50 reference items in total, at most 30 of them images (first and last frames included).
      mode: ["text", "endFrameOptional", ["imageReference:30", "videoReference:10", "audioReference:10"]],
      audio: "optional",
      durationResolutionMap: [{
        duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
        resolution: ["480p", "720p", "1080p"],
      }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const params: Record<string, string | number | boolean> = {};
    if (request.duration !== undefined) params.duration = request.duration;
    if (request.ratio) params.aspect_ratio = request.ratio;
    if (request.resolution) params.resolution = request.resolution;
    if (typeof request.generateAudio === "boolean") params.generate_audio = request.generateAudio;
    const media = {
      "start-image": request.firstFrame ? [request.firstFrame] : [],
      "end-image": request.lastFrame ? [request.lastFrame] : [],
      "image-references": request.images ?? [],
      "video-references": request.videos ?? [],
      "audio-references": request.audios ?? [],
    };
    // Seedance 2.5 needs an explicit mode: text-only jobs are t2v, anything with frames or references is omni_reference.
    if (request.model === "seedance_2_5") params.mode = Object.values(media).some(items => items.length) ? "omni_reference" : "t2v";
    const { url } = await this.tool.higgsfield({ jobType: request.model, prompt: request.prompt, params, media });
    return [{ mediaType: "video", type: "url", url }];
  },
} satisfies ProviderDefinition<typeof rules>;
