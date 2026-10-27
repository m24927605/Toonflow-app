const rules = [] as const;

const version = "1.0.0";

export default {
  id: "lustify" as const,
  label: "LUSTIFY v10 · Krea 2 (Colab)",
  version,
  readme: "Draws photorealistic stills, explicit ones included, with LUSTIFY v10 (Krea 2), a community finetune of Krea 2 Turbo, on a Colab A100 through Comfy-Org's official Krea 2 Turbo template (Euler, Beta, 8 steps, CFG 1). Connected character LoRAs (trained on Krea 2) are listed in the left-to-right order the people stand in the frame: the frame is drawn first without them, then drawn again with each LoRA confined to that person's head, so bodies and poses stay as LUSTIFY drew them. Given a picture to redraw, it redraws only the locked heads, or the white of a mask, and keeps the rest. Name each character by their LoRA trigger in the prompt. The Krea 2 licence forbids circumventing its safety measures; LUSTIFY is a third-party finetune used at your own risk.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nMachines keep running, and billing, until you stop them with Stop Colab session in the language model settings; Toonflow never stops one by itself. Toonflow never reads or forwards the Colab credentials.",
  rules,
  models: [
    {
      id: "lustify_v10_krea2",
      label: "LUSTIFY v10 (Krea 2)",
      type: "image",
      mode: ["text"],
      imageSizes: ["1K"],
      imageRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    if (request.images?.length) throw new Error("LUSTIFY takes no reference images; it draws from text, character LoRAs and a picture to redraw");
    if (request.initImage && !(typeof request.denoise === "number" && request.denoise > 0 && request.denoise <= 1)) throw new Error("Redrawing a picture with LUSTIFY needs a denoise above 0 and up to 1");
    if (request.mask && !request.initImage) throw new Error("A LUSTIFY mask needs the picture it marks");
    const { data, mimeType, seed } = await this.tool.lustify({ prompt: request.prompt, ratio: request.ratio ?? "16:9", loras: request.loras, seed: request.seed, initImage: request.initImage, denoise: request.denoise, mask: request.mask });
    return [{ mediaType: "image", type: "binary", data, mimeType, seed }];
  },
} satisfies ProviderDefinition<typeof rules>;
