const rules = [] as const;

const version = "1.0.0";

export default {
  id: "wanRemix" as const,
  label: "Wan 2.2 Remix V3 (Colab)",
  version,
  readme: "Turns a start image into a silent five-second-or-shorter clip, explicit ones included, with Wan 2.2 Remix V3 (FX-FeiHou/wan2.2-Remix, the NSFW image-to-video fp8 v3.0 experts with lightning and NSFW LoRAs merged in) on a Colab A100, as its author's workflow sets it up: the NSFW UMT5 text encoder the model card recommends, 8 Euler steps split between the high and low noise experts at CFG 1 and shift 8, 16 fps at 720p. Wan 2.2 Remix V3 · Reveal Penis adds TenStrip's Wan 2.2 I2V Reveal Penis LoRA pair at full strength, for a man baring an erect penis. Connect an end image as well to pin the clip's last frame. Write the prompt as comma-joined short phrases: who does what, then the camera, the light and the style, one action per clip. The Remix licence is not stated; Wan 2.2 is Apache 2.0.\n\n1. Install the CLI: `uv tool install google-colab-cli`\n2. Sign in once: run `colab sessions` in a terminal and finish the Google sign-in.\n\nMachines keep running, and billing, until you stop them with Stop Colab session in the language model settings; Toonflow never stops one by itself. Toonflow never reads or forwards the Colab credentials.",
  rules,
  models: [
    {
      id: "wan22_remix_v3",
      label: "Wan 2.2 Remix V3",
      type: "video",
      mode: ["singleImage", "endFrameOptional"],
      audio: false,
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5], resolution: ["720p"] }],
    },
    {
      id: "wan22_remix_v3_reveal_penis",
      label: "Wan 2.2 Remix V3 · Reveal Penis",
      type: "video",
      mode: ["singleImage", "endFrameOptional"],
      audio: false,
      durationResolutionMap: [{ duration: [1, 2, 3, 4, 5], resolution: ["720p"] }],
    },
  ] satisfies ProviderModel[],
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const firstFrame = request.firstFrame ?? request.images?.[0];
    if (!firstFrame || (request.images?.length ?? 0) > 1 || request.videos?.length || request.audios?.length) throw new Error("Wan Remix takes one start image, an optional end image and no other references");
    if ((request.resolution ?? "720p") !== "720p") throw new Error("Wan Remix renders 720p only");
    const { data, mimeType, seed } = await this.tool.wanRemix({
      prompt: request.prompt, firstFrame, lastFrame: request.lastFrame, duration: request.duration ?? 5, ratio: request.ratio ?? "16:9",
      revealPenis: request.model === "wan22_remix_v3_reveal_penis", seed: request.seed,
    });
    return [{ mediaType: "video", type: "binary", data, mimeType, seed }];
  },
} satisfies ProviderDefinition<typeof rules>;
