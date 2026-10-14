const rules = [] as const;

const version = "1.3.0";

export default {
  id: "qwenImage" as const,
  label: "Qwen-Image (Colab)",
  version,
  readme: "Draws images with the open-weight Qwen-Image 2.1 Turbo model on a Google Colab A100, through the Colab CLI installed on the computer running Toonflow.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nImage requests made around the same time, for example several image nodes generated together or a batch started by an agent, are gathered (until 10 seconds pass without a new one, 60 seconds at most) and drawn in one A100 session, so the setup of a few minutes is paid once per batch; each extra image adds seconds at 1K and under a minute at 2K. Requests made while a batch runs form the next batch. Jobs use the compute units of your Colab plan.\n\nWithout references the image is drawn at the chosen ratio; with up to 16 connected reference images it edits or combines them, still at the chosen ratio.\n\nThe depth control model takes the first connected image as a depth map (near white, far black), for example a keyframe depth map exported from the director node, and draws the new image with exactly that composition and viewpoint; the other connected images (up to 15) set the look. Use it for angles that editing a reference cannot reach, such as the side or back of a subject.\n\nThe Colab CLI writes its sign-in tokens to `~/.config/colab-cli/colab.log` in plain text, so Toonflow points that log at the null device before each job and refuses to run while a regular log file exists. Toonflow never reads or forwards the Colab credentials.",
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
    {
      id: "qwen_image_2_1_turbo_depth",
      label: "Qwen-Image 2.1 Turbo (depth control)",
      type: "image",
      mode: ["singleImage", "multiReference"],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const size = request.size ?? "1K";
    if (size !== "1K" && size !== "2K") throw new Error("Qwen-Image supports only 1K and 2K");
    const [first, ...rest] = request.images ?? [];
    const depth = request.model === "qwen_image_2_1_turbo_depth";
    if (depth && !first) throw new Error("Connect a depth map as the first reference image for depth control");
    // The depth map leaves the reference list, so {{ref 1}} names it and later markers shift down to the images sent.
    const prompt = depth ? request.prompt.replace(/\{\{ref (\d+)\}\}/g, (_, index) => index === "1" ? "the depth map" : `{{ref ${Number(index) - 1}}}`) : request.prompt;
    const { data, mimeType } = await this.tool.qwenImage({
      prompt, ratio: request.ratio ?? "1:1", size, loras: request.loras,
      ...(depth ? { images: rest, controlImage: first } : { images: request.images ?? [] }),
    });
    return [{ mediaType: "image", type: "binary", data, mimeType }];
  },
} satisfies ProviderDefinition<typeof rules>;
