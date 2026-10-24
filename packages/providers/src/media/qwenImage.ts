const rules = [] as const;

const version = "1.7.0";

export default {
  id: "qwenImage" as const,
  label: "Qwen-Image (Colab)",
  version,
  readme: "Draws images with the open-weight Qwen-Image 2.1 base model (40 steps, not Turbo) and, on every image, the Genitalia Anatomy Fix LoRA (perpetual3x, non-commercial licence) on a Google Colab A100, through the Colab CLI installed on the computer running Toonflow.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nImage requests made around the same time, for example several image nodes generated together or a batch started by an agent, are gathered (after a 50 ms quiet window, 250 ms at most) and drawn in one A100 session, so the setup of a few minutes is paid once per batch; each extra image adds seconds at 1K and under a minute at 2K. Requests made while a batch runs form the next batch. Jobs use the compute units of your Colab plan.\n\nWithout references the image is drawn at the chosen ratio; with up to 10 connected reference images it edits or combines them, still at the chosen ratio.\n\nThe depth control model takes the first connected image as a depth map (near white, far black), for example a keyframe depth map exported from the director node, and draws the new image with exactly that composition and viewpoint; the other connected images (up to 9) set the look. Use it for angles that editing a reference cannot reach, such as the side or back of a subject.\n\nPose transfer uses the base Qwen-Image 2.1 model, with recipes from the Apache-2.0 qwen21-nsfw-pose-skill. Pose transfer takes a textureless 3D mannequin render (for example a figure from the director node) as the first image and a picture of the person as the second, and draws that person in the mannequin's pose; a full-body mannequin works best, and a photo or illustration does not work as the pose.\n\nThe Colab CLI writes its sign-in tokens to `~/.config/colab-cli/colab.log` in plain text, so Toonflow points that log at the null device before each job and refuses to run while a regular log file exists. Toonflow never reads or forwards the Colab credentials.",
  rules,
  models: [
    {
      id: "qwen_image_2_1",
      label: "Qwen-Image 2.1",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "qwen_image_2_1_depth",
      label: "Qwen-Image 2.1 (depth control)",
      type: "image",
      mode: ["singleImage", "multiReference"],
      imageSizes: ["1K", "2K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
    {
      id: "qwen_image_2_1_pose",
      label: "Qwen-Image 2.1 (pose transfer)",
      type: "image",
      mode: ["multiReference"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (!["qwen_image_2_1", "qwen_image_2_1_depth", "qwen_image_2_1_pose"].includes(request.model)) throw new Error("This production uses the B3 image models only");
    const size = request.size ?? "1K";
    if (size !== "1K" && size !== "2K") throw new Error("Qwen-Image supports only 1K and 2K");
    const [first, ...rest] = request.images ?? [];
    const depth = request.model === "qwen_image_2_1_depth";
    if (depth && !first) throw new Error("Connect a depth map as the first reference image for depth control");
    if (request.model === "qwen_image_2_1_pose") {
      if ((request.images?.length ?? 0) < 2) throw new Error("Connect a textureless mannequin render as the first image and the person as the second for pose transfer");
      // Pose transfer uses the official numbered image tags and assigns both references a distinct role.
      const prompt = ["Replace the pose of <image2> with the pose of the mannequin in <image1>. Keep the identity and clothing from <image2> unchanged", request.prompt.trim()].filter(Boolean).join(". ");
      const { data, mimeType, seed } = await this.tool.qwenImage({ prompt, ratio: request.ratio ?? "1:1", size, images: request.images, loras: request.loras, seed: request.seed, recipe: "pose" });
      return [{ mediaType: "image", type: "binary", data, mimeType, seed }];
    }
    // Single-image edits refer to the image naturally; multi-image edits use the model's numbered tags.
    const imageCount = (request.images?.length ?? 0) - (depth ? 1 : 0);
    const label = (index: number) => {
      if (depth && index === 1) return "the depth map";
      return imageCount === 1 ? "the image" : `<image${index - (depth ? 1 : 0)}>`;
    };
    const prompt = request.prompt.replace(/\{\{ref (\d+)\}\}/g, (_, index) => label(Number(index)));
    const { data, mimeType, seed } = await this.tool.qwenImage({
      prompt, ratio: request.ratio ?? "1:1", size, loras: request.loras, seed: request.seed, initImage: request.initImage, denoise: request.denoise,
      ...(depth ? { images: rest, controlImage: first } : { images: request.images ?? [] }),
    });
    return [{ mediaType: "image", type: "binary", data, mimeType, seed }];
  },
} satisfies ProviderDefinition<typeof rules>;
