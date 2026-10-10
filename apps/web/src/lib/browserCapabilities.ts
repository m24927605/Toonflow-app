// ACT: This is also serialized into the native shell's preflight page; keep it self-contained, no module variables.
export function getMissingBrowserFeatures(): string[] {
  const browser = globalThis as typeof globalThis & {
    ResizeObserver?: unknown;
    CSS?: { supports?: (property: string, value: string) => boolean };
  };
  const features: [string, unknown][] = [
    ["Map.groupBy", browser.Map?.groupBy],
    ["URL.canParse", browser.URL?.canParse],
    ["Promise.withResolvers", browser.Promise?.withResolvers],
    ["Intl.Segmenter", browser.Intl?.Segmenter],
    ["crypto.randomUUID", browser.crypto?.randomUUID],
    ["TextDecoderStream", browser.TextDecoderStream],
    ["ReadableStream", browser.ReadableStream],
    ["ResizeObserver", browser.ResizeObserver],
    ["AbortSignal.any", browser.AbortSignal?.any],
    ["AbortSignal.timeout", browser.AbortSignal?.timeout],
    ["structuredClone", browser.structuredClone],
  ];
  const missing = features.filter(([, method]) => typeof method !== "function").map(([name]) => name);
  if (!browser.CSS?.supports?.("color", "color-mix(in srgb, red, blue)")) missing.push("CSS color-mix");
  return missing;
}
