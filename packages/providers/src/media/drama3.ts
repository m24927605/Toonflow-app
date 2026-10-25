export default {
  id: "drama3" as const,
  label: "Fish Audio Drama 3 (Colab)",
  version: "1.1.1",
  rules: [],
  readme: "Fish Audio Drama 3 original weights on a private Colab A100 80GB through the signed-in Colab CLI; at least 48 GiB VRAM is required. No API key or public tunnel. New voices require an explicit voice and performance description in emotion, passed as bracketed natural-language descriptors with the native speaker token. One reference audio with its exact transcript preserves a previously generated voice. References must last 1–30 seconds. First use downloads the pinned model and installs vLLM-Omni. Startup and idle time consume Colab units. Machines keep running, and billing, until you stop them with Stop Colab session in the language model settings; Toonflow never stops one by itself. Language is included in the direction when supplied. Numeric speed, pitch and volume controls are unsupported. Voice descriptions guide generation but require audible acceptance before reuse.",
  models: [{ id: "fishaudio/drama-3", label: "Drama 3", type: "audio" }],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const text = request.text?.trim() || request.prompt?.trim();
    if (!text) throw new Error("Enter the text to read aloud");
    if ((request.audios?.length ?? 0) > 1) throw new Error("Drama 3 accepts one voice reference per request");
    const reference = request.audios?.[0];
    if (reference && !reference.text?.trim()) throw new Error("Drama 3 voice references need their exact transcript");
    if (request.images?.length) throw new Error("Drama 3 supports audio references, not image references");
    if ((request.speed ?? 1) !== 1 || (request.volume ?? 0) !== 0 || (request.pitch ?? 0) !== 0) {
      throw new Error("Drama 3 does not support numeric speed, volume or pitch controls");
    }
    if (request.voice && request.voice !== "default") throw new Error("Drama 3 has no named preset voices; use a reference audio and transcript");
    const format = request.format ?? "wav";
    if (!["wav", "mp3"].includes(format)) throw new Error("Drama 3 supports WAV or MP3 output");
    if (!reference && !request.emotion?.trim()) throw new Error("A new Drama 3 voice requires an explicit voice and performance description in emotion");
    if (/[\r\n]|<\|/.test(request.emotion ?? "") || /[\r\n\[\]<>]/.test(request.language ?? "")) throw new Error("Voice directions and language must be plain single-line descriptions");
    const direction = [request.emotion, request.language ? `Speak in ${request.language}.` : ""].filter(Boolean).join(" ");
    const result = await this.tool.drama3({ text, direction, reference: reference ? { audio: reference, text: reference.text!.trim() } : undefined });
    if (format === "mp3" || request.sampleRate) {
      const converted = await this.tool.audio.convert(result.data, { format: format === "mp3" ? "mp3" : "wav", sampleRate: request.sampleRate });
      return [{ type: "binary", ...converted, mediaType: "audio" }];
    }
    return [{ type: "binary", ...result, mediaType: "audio" }];
  },
} satisfies ProviderDefinition<[]>;
