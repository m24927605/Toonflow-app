const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const version = "1.0.0";
const apiUrl = "https://api.openai.com/v1";
// 1K ≈ 1024², 2K = 2560×1440 (largest non-experimental size), 4K = 3840×2160 (API maximum).
const pixelBudgets: Record<string, number> = { "1K": 1024 * 1024, "2K": 2560 * 1440, "4K": 3840 * 2160 };

/** Turns a size tier and aspect ratio into WIDTHxHEIGHT within the API limits: multiples of 16, edges ≤ 3840. */
function imageSize(size = "1K", ratio = "1:1") {
  if (/^\d+x\d+$/.test(size)) return size;
  const pixels = pixelBudgets[size.toUpperCase()];
  const [width, height] = ratio.split(":").map(Number);
  if (!pixels || !width || !height) throw new Error(`不支持的图片尺寸：${size} ${ratio}`);
  const scale = Math.min(Math.sqrt(pixels / (width * height)), 3840 / Math.max(width, height));
  const fit = (value: number) => Math.max(16, Math.floor(value * scale / 16) * 16);
  return `${fit(width)}x${fit(height)}`;
}

/** Builds a multipart body by hand; the provider sandbox exposes Blob but not FormData. */
function multipart(fields: Record<string, string>, files: { name: string; input: MediaInput }[]) {
  const boundary = `----toonflow${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts: (string | Uint8Array<ArrayBuffer>)[] = Object.entries(fields)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  files.forEach(({ name, input }, index) => {
    if (input.type === "url") throw new Error("参考图需为本地数据，不支持远程地址");
    const bytes = input.type === "binary" ? input.data : Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64");
    const extension = input.mimeType.split("/")[1] || "png";
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${index}.${extension}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`,
      new Uint8Array(bytes),
      "\r\n",
    );
  });
  parts.push(`--${boundary}--\r\n`);
  return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export default {
  id: "openai" as const,
  label: "OpenAI",
  version,
  readme: "Image generation with the OpenAI Images API. The API key is only sent to api.openai.com. To keep it out of Toonflow's settings, enter `env:VARIABLE_NAME` instead; Toonflow then reads that variable from its process environment or `~/.env`. GPT Image models require a verified API organization.",
  rules,
  models: [
    {
      id: "gpt-image-2.5-sunburst",
      label: "GPT Image 2.5 Sunburst",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "2K", "4K"],
      imageRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) throw new Error("请填写 API Key");
    const images = request.images ?? [];
    if (images.length > 16) throw new Error("最多支持 16 张参考图");
    const format = request.outputFormat ?? "png";
    const fields: Record<string, string> = {
      model: request.model,
      prompt: request.prompt,
      size: imageSize(request.size, request.ratio),
      n: String(request.n ?? 1),
      output_format: format,
      ...(request.quality ? { quality: request.quality } : {}),
    };
    // ACT: A single generation waits at most 10 minutes; complex prompts can take about 2.
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    // Reference images and the optional mask go to the edits endpoint as multipart files; text-only uses JSON.
    const { body, contentType } = images.length
      ? multipart(fields, [...images.map(input => ({ name: "image[]", input })), ...(request.mask ? [{ name: "mask", input: request.mask }] : [])])
      : { body: JSON.stringify({ ...fields, n: request.n ?? 1 }), contentType: "application/json" };
    const response = await this.tool.fetch(`${apiUrl}/images/${images.length ? "edits" : "generations"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": contentType },
      body,
      signal,
    });
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    const result = await response.json() as { data?: { b64_json?: string }[] };
    const assets = (result.data ?? []).flatMap(item => item.b64_json
      ? [{ mediaType: "image" as const, type: "base64" as const, data: item.b64_json, mimeType: `image/${format}` }]
      : []);
    if (!assets.length) throw new Error("未返回生成结果");
    return assets;
  },
} satisfies ProviderDefinition<typeof rules>;
