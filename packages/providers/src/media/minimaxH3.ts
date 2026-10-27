const rules = [] as const;

const version = "2.0.0";

export default {
  id: "minimaxH3" as const,
  label: "MiniMax H3 (Colab)",
  version,
  readme: "Generates videos with sound using MiniMax H3 on a Colab A100 through the ComfyUI templates MiniMax's README points to (Comfy-Org/workflow_templates video_minimax_h3_i2v and video_minimax_h3_r2v), exactly as published but for their user inputs: the images, the prompt, the seed, the duration and the aspect ratio at the templates' official 768p. H3 · I2VA opens on one first frame; H3 · Ref2VA takes 1 to 9 reference images labelled <Picture 1> to <Picture N> in their order. Both use the official Comfy-Org weights with the Lightning LoRA off, as the templates ship. Write the prompt in MiniMax's official format (the h3-prompt-writing skill): the I2VA instruction line and the three fields, or the six Ref2VA sections; spoken lines go in <d>[Language] ...</d>.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nMachines keep running, and billing, until you stop them with Stop Colab session in the language model settings; Toonflow never stops one by itself. Toonflow never reads or forwards the Colab credentials.",
  rules,
  models: [
    {
      id: "minimax_h3_i2va",
      label: "H3 · I2VA",
      type: "video",
      mode: ["singleImage"],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p"] }],
    },
    {
      id: "minimax_h3_ref2va",
      label: "H3 · Ref2VA",
      type: "video",
      mode: [["imageReference:9"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["720p"] }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    if (request.videos?.length || request.audios?.length) throw new Error("MiniMax H3 here takes images only");
    const images = request.model === "minimax_h3_i2va" ? [request.firstFrame ?? request.images?.[0]].filter(image => image !== undefined) : request.images ?? [];
    const { data, mimeType, seed } = await this.tool.minimaxH3({
      mode: request.model === "minimax_h3_i2va" ? "i2v" : "r2v", prompt: request.prompt, images,
      duration: request.duration ?? 5, ratio: request.ratio ?? "16:9", seed: request.seed,
    });
    return [{ mediaType: "video", type: "binary", data, mimeType, seed }];
  },
} satisfies ProviderDefinition<typeof rules>;
