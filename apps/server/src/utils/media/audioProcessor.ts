import { types } from "node:util";
import { Mp3Encoder } from "@breezystack/lamejs";
import { WaveFile } from "wavefile";
import type { AudioConvertOptions } from "@toonflow/providers";

const maxInputBytes = 100 * 1024 * 1024;
// ACT: The limit assumes 30 minutes of 48kHz stereo, so malformed WAV headers claiming huge durations cannot exhaust memory.
const maxSamplesPerChannel = 48000 * 60 * 30;
const mimeTypes = { wav: "audio/wav", mp3: "audio/mpeg" } as const;
const mp3BlockSize = 1152;

function invalid(message: string): never {
  throw new Error(message);
}

/**
 * Accepts in-memory WAV bytes and returns processed in-memory bytes; never reads/writes files or resolves paths or URLs.
 * ACT: Only WAV input is supported (wavefile cannot decode compressed
 * formats like mp3/aac); mp3 output is encoded with lamejs.
 */
export async function convertAudio(input: Uint8Array, options: AudioConvertOptions, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
  signal?.throwIfAborted();
  // Provider code runs in a separate VM realm where cross-realm TypedArrays fail instanceof, so check with util.types.
  if (!types.isUint8Array(input)) invalid("Audio input must be a Uint8Array");
  if (input.byteLength === 0 || input.byteLength > maxInputBytes) invalid("Invalid audio input size");
  if (options.format !== "wav" && options.format !== "mp3") invalid("The output format only supports wav or mp3");
  const { startSeconds, endSeconds, sampleRate: targetSampleRate, bitrateKbps } = options;
  if (startSeconds !== undefined && !(Number.isFinite(startSeconds) && startSeconds >= 0)) invalid("Invalid audio trim start time");
  if (endSeconds !== undefined && !(Number.isFinite(endSeconds) && endSeconds > 0)) invalid("Invalid audio trim end time");
  if (startSeconds !== undefined && endSeconds !== undefined && startSeconds >= endSeconds) invalid("Invalid audio trim range");
  if (targetSampleRate !== undefined && !(Number.isInteger(targetSampleRate) && targetSampleRate >= 4000 && targetSampleRate <= 192000)) invalid("Invalid sampling rate");
  if (bitrateKbps !== undefined && !(Number.isInteger(bitrateKbps) && bitrateKbps >= 32 && bitrateKbps <= 320)) invalid("Invalid MP3 bitrate");

  let wave: WaveFile;
  try { wave = new WaveFile(Uint8Array.from(input)); }
  catch { invalid("The audio input is not valid WAV data"); }

  const fmt = wave.fmt as { numChannels: number; sampleRate: number };
  const numChannels = fmt.numChannels;
  const sourceSampleRate = fmt.sampleRate;
  if (!Number.isInteger(numChannels) || numChannels < 1 || numChannels > 2) invalid("Only supports mono or two-channel audio");
  if (!Number.isInteger(sourceSampleRate) || sourceSampleRate <= 0) invalid("Invalid audio sampling rate");

  wave.toBitDepth("16");
  const raw = wave.getSamples(false, Int16Array) as unknown as Int16Array | Int16Array[];
  const channels = numChannels === 1 ? [raw as Int16Array] : raw as Int16Array[];
  const totalSamples = channels[0]?.length ?? 0;
  if (totalSamples === 0 || totalSamples > maxSamplesPerChannel) invalid("The audio duration is invalid or exceeds the limit");

  const startSample = startSeconds !== undefined ? Math.round(startSeconds * sourceSampleRate) : 0;
  const endSample = endSeconds !== undefined ? Math.round(endSeconds * sourceSampleRate) : totalSamples;
  if (startSample < 0 || endSample > totalSamples || startSample >= endSample) invalid("The trim range exceeds the audio duration");
  const trimmed = channels.map(channel => channel.subarray(startSample, endSample));

  signal?.throwIfAborted();
  const output = new WaveFile();
  output.fromScratch(numChannels, sourceSampleRate, "16", numChannels === 1 ? trimmed[0] : trimmed);
  if (targetSampleRate !== undefined && targetSampleRate !== sourceSampleRate) output.toSampleRate(targetSampleRate);
  const finalSampleRate = targetSampleRate ?? sourceSampleRate;

  if (options.format === "wav") return { data: output.toBuffer(), mimeType: mimeTypes.wav };

  signal?.throwIfAborted();
  const pcm = output.getSamples(false, Int16Array) as unknown as Int16Array | Int16Array[];
  const pcmChannels = numChannels === 1 ? [pcm as Int16Array] : pcm as Int16Array[];
  const frames = pcmChannels[0]!.length;
  const encoder = new Mp3Encoder(numChannels, finalSampleRate, bitrateKbps ?? 128);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < frames; i += mp3BlockSize) {
    const chunk = numChannels === 2
      ? encoder.encodeBuffer(pcmChannels[0]!.subarray(i, i + mp3BlockSize), pcmChannels[1]!.subarray(i, i + mp3BlockSize))
      : encoder.encodeBuffer(pcmChannels[0]!.subarray(i, i + mp3BlockSize));
    if (chunk.length) chunks.push(new Uint8Array(chunk));
  }
  const flushed = encoder.flush();
  if (flushed.length) chunks.push(new Uint8Array(flushed));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (size === 0) invalid("MP3 encoding failed");
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return { data, mimeType: mimeTypes.mp3 };
}
