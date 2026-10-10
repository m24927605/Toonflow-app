const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const version = "1.1.0";
const apiUrl = "https://generativelanguage.googleapis.com/v1beta";
// Toonflow language values mapped to Gemini BCP-47 codes; anything else leaves detection to the model.
const languageCodes: Record<string, string> = { "zh-CN": "cmn-CN", en: "en-US", ja: "ja-JP" };

/** Returns the PCM samples of a WAV file by locating its `data` chunk. */
function wavData(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 12; offset + 8 <= bytes.length; offset += 8 + view.getUint32(offset + 4, true)) {
    if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === "data") return bytes.subarray(offset + 8, offset + 8 + view.getUint32(offset + 4, true));
  }
  throw new Error("Gemini 返回的 WAV 缺少音频数据");
}

export default {
  id: "gemini" as const,
  label: "Google Gemini",
  version,
  readme: "Text-to-speech with Gemini 3.8 Flash TTS through the Gemini API. The API key is only sent to generativelanguage.googleapis.com; enter `env:VARIABLE_NAME` to read it from the Toonflow process environment or `~/.env` instead of storing it. The text is read verbatim; a separate style prompt or emotion (e.g. \"calm, speaking slowly\") controls tone and pace, and tags such as `<short pause>` or `<laugh>` can be placed in the text.",
  rules,
  models: [
    {
      id: "gemini-3.8-flash-tts",
      label: "Gemini 3.8 Flash TTS",
      type: "audio",
      // Gemini's 30 prebuilt voices with their official tone descriptions.
      voices: [
        { title: "Kore (Firm)", voice: "Kore" },
        { title: "Puck (Upbeat)", voice: "Puck" },
        { title: "Zephyr (Bright)", voice: "Zephyr" },
        { title: "Charon (Informative)", voice: "Charon" },
        { title: "Fenrir (Excitable)", voice: "Fenrir" },
        { title: "Leda (Youthful)", voice: "Leda" },
        { title: "Orus (Firm)", voice: "Orus" },
        { title: "Aoede (Breezy)", voice: "Aoede" },
        { title: "Callirrhoe (Easy-going)", voice: "Callirrhoe" },
        { title: "Autonoe (Bright)", voice: "Autonoe" },
        { title: "Enceladus (Breathy)", voice: "Enceladus" },
        { title: "Iapetus (Clear)", voice: "Iapetus" },
        { title: "Umbriel (Easy-going)", voice: "Umbriel" },
        { title: "Algieba (Smooth)", voice: "Algieba" },
        { title: "Despina (Smooth)", voice: "Despina" },
        { title: "Erinome (Clear)", voice: "Erinome" },
        { title: "Algenib (Gravelly)", voice: "Algenib" },
        { title: "Rasalgethi (Informative)", voice: "Rasalgethi" },
        { title: "Laomedeia (Upbeat)", voice: "Laomedeia" },
        { title: "Achernar (Soft)", voice: "Achernar" },
        { title: "Alnilam (Firm)", voice: "Alnilam" },
        { title: "Schedar (Even)", voice: "Schedar" },
        { title: "Gacrux (Mature)", voice: "Gacrux" },
        { title: "Pulcherrima (Forward)", voice: "Pulcherrima" },
        { title: "Achird (Friendly)", voice: "Achird" },
        { title: "Zubenelgenubi (Casual)", voice: "Zubenelgenubi" },
        { title: "Vindemiatrix (Gentle)", voice: "Vindemiatrix" },
        { title: "Sadachbia (Lively)", voice: "Sadachbia" },
        { title: "Sadaltager (Knowledgeable)", voice: "Sadaltager" },
        { title: "Sulafat (Warm)", voice: "Sulafat" },
      ],
    },
  ] satisfies ProviderModel[],
  async generateAudio(request: AudioRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const text = request.text?.trim() || request.prompt?.trim();
    if (!text) throw new Error("请输入待朗读文本");
    if ([request.speed ?? 1, request.volume ?? 0, request.pitch ?? 0].join() !== "1,0,0") {
      throw new Error("Gemini TTS 不支持数值语速、音量和音调，请在风格提示中描述");
    }
    const format = request.format ?? "wav";
    if (!["wav", "mp3", "pcm"].includes(format)) throw new Error(`Gemini TTS 不支持输出格式：${format}`);
    // The text field is read aloud verbatim, so tone and pace go into the style metadata instead.
    const style = [request.text ? request.prompt?.trim() : "", request.emotion?.trim()].filter(Boolean).join(", ");
    const languageCode = request.language ? languageCodes[request.language] : undefined;
    const signal = AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const response = await this.tool.fetch(`${apiUrl}/models/${request.model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text, ...(style ? { speechMetadata: { style } } : {}) }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { voice: request.voice || "Kore" }, ...(languageCode ? { languageCode } : {}) },
        },
      }),
      signal,
    });
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    const result = await response.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] };
    const audio = result.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData?.data;
    if (!audio) throw new Error("未返回生成结果");
    // Non-streaming responses are complete 24 kHz mono 16-bit WAV files.
    let bytes: Uint8Array = Buffer.from(audio, "base64");
    if (format !== "wav" || (request.sampleRate && request.sampleRate !== 24000)) {
      bytes = (await this.tool.audio.convert(bytes, { format: format === "mp3" ? "mp3" : "wav", sampleRate: request.sampleRate })).data;
    }
    if (format === "pcm") return [{ mediaType: "audio", type: "base64", data: Buffer.from(wavData(bytes)).toString("base64"), mimeType: "audio/pcm" }];
    return [{ mediaType: "audio", type: "base64", data: Buffer.from(bytes).toString("base64"), mimeType: format === "mp3" ? "audio/mpeg" : "audio/wav" }];
  },
} satisfies ProviderDefinition<typeof rules>;
