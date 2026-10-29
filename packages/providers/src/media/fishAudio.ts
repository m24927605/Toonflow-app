const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const apiUrl = "https://api.fish.audio/v1";

function bytes(input: MediaInput) {
  if (input.type === "url") throw new Error("Fish Audio voice references must be local audio");
  return input.type === "binary" ? input.data : new Uint8Array(Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64"));
}

export default {
  id: "fishAudio" as const,
  label: "Fish Audio",
  version: "1.0.0",
  rules,
  readme: "Fish Audio's hosted Drama 3 through its API; text, voice descriptions and reference audio are sent to Fish Audio and billed to the API credit. A voice reference with its exact transcript reads the text in that voice; without one, the voice description in emotion designs a new voice that speaks the text (up to 150 characters). Write vocal events such as [moaning] or [panting] inside the text, after a real word. Fish Audio's terms forbid sexually explicit content.",
  models: [{ id: "drama-3", label: "Drama 3", type: "audio" }] satisfies ProviderModel[],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("Please fill in the API Key");
    const text = request.text?.trim() || request.prompt?.trim();
    if (!text) throw new Error("Enter the text to read aloud");
    if ((request.audios?.length ?? 0) > 1) throw new Error("Fish Audio accepts one voice reference per request");
    if (request.images?.length) throw new Error("Fish Audio supports audio references, not image references");
    if ((request.speed ?? 1) !== 1 || (request.volume ?? 0) !== 0 || (request.pitch ?? 0) !== 0) throw new Error("Fish Audio Drama 3 does not take numeric speed, volume or pitch controls here");
    if (request.voice && request.voice !== "default") throw new Error("Fish Audio has no named preset voices here; use a reference audio and transcript");
    const format = request.format ?? "wav";
    if (!["wav", "mp3"].includes(format)) throw new Error("Fish Audio supports WAV or MP3 output");
    const reference = request.audios?.[0];
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    let audio: Uint8Array;
    if (reference) {
      if (!reference.text?.trim()) throw new Error("Fish Audio voice references need their exact transcript");
      if (request.emotion?.trim()) throw new Error("A voice description only designs a new voice; with a reference, write vocal events in the text");
      // Inline references must be sent as MessagePack; JSON is rejected.
      const response = await this.tool.fetch(`${apiUrl}/tts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/msgpack", model: "drama-3" },
        body: this.tool.msgpack.encode({ text, references: [{ audio: bytes(reference), text: reference.text.trim() }], format: "wav", sample_rate: 44100 }),
        signal,
      });
      if (!response.ok) throw new Error(`Request failed: HTTP ${response.status}`);
      audio = new Uint8Array(await response.arrayBuffer());
    } else {
      const instruction = request.emotion?.trim();
      if (!instruction) throw new Error("A new Fish Audio voice requires a voice description in emotion");
      if ([...text].length > 150) throw new Error("A new voice's sample text must be at most 150 characters");
      const response = await this.tool.fetch(`${apiUrl}/voice-design`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", model: "voice-design-1" },
        body: JSON.stringify({ instruction, reference_text: text, n: 1, ...(request.language ? { language: request.language } : {}) }),
        signal,
      });
      if (!response.ok) throw new Error(`Request failed: HTTP ${response.status}`);
      const result = await response.json() as { candidates?: { audio_base64?: string }[] };
      const candidate = result.candidates?.[0]?.audio_base64;
      if (!candidate) throw new Error("No generation result returned");
      audio = new Uint8Array(Buffer.from(candidate, "base64"));
    }
    const wav = new TextDecoder().decode(audio.subarray(0, 4)) === "RIFF";
    if (!wav) throw new Error("Fish Audio did not return WAV audio");
    if (format === "mp3" || request.sampleRate) {
      const converted = await this.tool.audio.convert(audio, { format: format === "mp3" ? "mp3" : "wav", sampleRate: request.sampleRate });
      return [{ type: "binary", ...converted, mediaType: "audio" }];
    }
    return [{ type: "binary", data: audio, mimeType: "audio/wav", mediaType: "audio" }];
  },
} satisfies ProviderDefinition<typeof rules>;
