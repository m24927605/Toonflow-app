const rules = [] as const;

const version = "1.1.0";

export default {
  id: "qwenImage" as const,
  label: "Qwen-Image (Colab)",
  version,
  readme: "Draws images with the open-weight Qwen-Image 2.1 Turbo model on a Google Colab A100, through the Colab CLI installed on the computer running Toonflow.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nImage requests made around the same time, for example several image nodes generated together or a batch started by an agent, are gathered (until 10 seconds pass without a new one, 60 seconds at most) and drawn in one A100 session, so the setup of a few minutes is paid once per batch; each extra image adds seconds at 1K and under a minute at 2K. Requests made while a batch runs form the next batch. Jobs use the compute units of your Colab plan.\n\nWithout references the image is drawn at the chosen ratio; with up to 16 connected reference images it edits or combines them, and the result follows the first reference's aspect.\n\nThe Colab CLI writes its sign-in tokens to `~/.config/colab-cli/colab.log` in plain text, so Toonflow points that log at the null device before each job and refuses to run while a regular log file exists. Toonflow never reads or forwards the Colab credentials.",
  rules,
  models: [
    {
      id: "qwen_image_2_1_turbo",
      label: "Qwen-Image 2.1 Turbo",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const size = request.size ?? "1K";
    if (size !== "1K" && size !== "2K") throw new Error("Qwen-Image 只支持 1K 和 2K");
    const { data, mimeType } = await this.tool.qwenImage({ prompt: request.prompt, images: request.images ?? [], ratio: request.ratio ?? "1:1", size });
    return [{ mediaType: "image", type: "binary", data, mimeType }];
  },
} satisfies ProviderDefinition<typeof rules>;
