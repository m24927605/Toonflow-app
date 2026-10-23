import { colabLane, colabModelPrepared, createColabWorker, currentColabAllocation, waitForColabPreparation, type ColabPreparation } from "./colabPool";
import { preparationKey } from "./preparation";
import type { ProviderTools } from "@toonflow/providers";
import { inputBytes, inputExtension } from "@/utils/media/colab";
import pipeline from "./drama3Colab.py" with { type: "text" };
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { z } from "zod";

const worker = createColabWorker("drama3", 2);
const speechMode = () => currentColabAllocation()?.speechMode ?? "eager";
const speechRuntime = () => currentColabAllocation()?.speechRuntime ?? "vllm";
export function drama3Preparation(): ColabPreparation {
  const prefix = "drama3Prepare";
  const mode = speechMode();
  const sglang = speechRuntime() === "sglang";
  const timingOutput = sglang ? "/content/drama3SglangRuntime/preparationTimings.json" : "/content/drama3Runtime/preparationTimings.json";
  return { name: "drama3", runtime: sglang ? "drama3Sglang" : mode === "eager" ? "drama3Eager" : "drama3Compiled", installSource: sglang ? "sglang/1d6d0be42bd25cb3df43987dc24442e5a6023184" : "drama3/03c334818305d3b1666da01cd0f67d48a4f3e7a2", prefetch: true, timingOutput, job: {
    script: `${pipeline.slice(0, pipeline.indexOf("readyAt = time.monotonic()"))}\nprint("COLAB_DONE")\n`,
    uploads: [{ name: `${prefix}.json`, data: "{}" }], env: { DRAMA_JOB: prefix, DRAMA_RUNTIME: speechRuntime(), DRAMA_MODE: mode, TOONFLOW_LOAD_ONLY: 1 }, outputs: [timingOutput],
  } };
}
export const holdDrama3 = () => worker.hold();

// https://recipes.vllm.ai/fishaudio/drama-3: speaker tokens and ordinary bracketed descriptors.
function speechText(text: string, direction?: string) {
  if (!text.trim() || text.length > 20000) throw new Error("Drama 3 text must contain 1–20000 characters");
  if (text.replace(/<\|speaker:(?:[0-9]|1[0-5])\|>/g, "").includes("<|")) throw Object.assign(new Error("Drama 3 accepts speaker IDs from 0 to 15"), { status: 400 });
  if (!direction?.trim()) return text;
  if (/[\r\n\[\]<>]/.test(direction)) throw Object.assign(new Error("Drama 3 voice direction must be one plain descriptor without control tags"), { status: 400 });
  const speaker = /^\s*(<\|speaker:(?:[0-9]|1[0-5])\|>)\s*/.exec(text);
  return `${speaker?.[1] ?? "<|speaker:0|>"} [${direction.trim()}] ${speaker ? text.slice(speaker[0].length) : text}`;
}

/** Keeps the dependent reference/first-line work on the serving VM and returns every normalized artifact together. */
export async function runDrama3Sequence(request: {
  voiceText: string; voiceTranscript: string; lineText: string; direction: string; filters: string[];
  referenceAttempts: number; lineAttempts: number; maximumLineSeconds: number;
  reference?: NonNullable<Parameters<ProviderTools["drama3"]>[0]["reference"]>;
}, signal: AbortSignal) {
  if (!request.voiceText.trim() || !request.lineText.trim() || !Number.isFinite(request.maximumLineSeconds) || request.maximumLineSeconds <= 0 || !Number.isInteger(request.referenceAttempts) || request.referenceAttempts < 0 || request.referenceAttempts > 2 || !Number.isInteger(request.lineAttempts) || request.lineAttempts < 1 || request.lineAttempts > 2) throw new Error("Invalid speech sequence or recording bounds");
  const job = "drama3" + crypto.randomUUID().replaceAll("-", "");
  const reference = request.reference ? job + "Reference.wav" : undefined;
  const preparation = drama3Preparation();
  const { reference: voiceReference, direction, ...source } = request;
  const sequence = { ...source, voiceText: speechText(source.voiceText, direction), lineText: speechText(source.lineText, direction) };
  await waitForColabPreparation("drama3", signal);
  const [data] = await worker.run((session, jobSignal) => session.job({
    script: pipeline,
    uploads: [{ name: job + ".json", data: JSON.stringify({ sequence, reference, transcript: voiceReference?.text }) }, ...voiceReference ? [{ name: reference!, data: inputBytes(voiceReference.audio) }] : []],
    env: { DRAMA_JOB: job, DRAMA_RUNTIME: speechRuntime(), DRAMA_MODE: speechMode(), TOONFLOW_LOAD_ONLY: colabModelPrepared(colabLane(2), preparationKey(preparation)) ? 1 : 0 },
    outputs: [`/content/${job}Sequence.zip`], runtime: preparation.runtime,
  }, jobSignal), signal);
  const files = unzipSync(data!);
  if (Object.keys(files).some(name => !/^(result\.json|reference\.wav|line\.wav|(?:reference|line)Attempt[01]\.wav)$/.test(name))) throw new Error("Unexpected speech artifact name");
  const artifact = z.object({ file: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
  const result = z.object({ reference: z.object({ file: z.literal("reference.wav"), text: z.string().min(1), seconds: z.number().finite().positive().optional() }).nullable(), line: z.object({ file: z.literal("line.wav"), seconds: z.number().finite().positive() }).nullable(), error: z.string().optional(), attempts: z.array(z.object({ kind: z.enum(["reference", "line"]), file: z.string(), seconds: z.number().finite().nonnegative(), reason: z.string() })).max(4), artifacts: z.array(artifact).max(6), setupSeconds: z.number().nonnegative(), sequenceSeconds: z.number().nonnegative(), phases: z.array(z.object({ name: z.string(), seconds: z.number().nonnegative() })).max(4) }).parse(JSON.parse(new TextDecoder().decode(files["result.json"])));
  for (const item of result.artifacts) {
    const bytes = files[item.file];
    if (!bytes || bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error("Speech artifact digest mismatch");
  }
  const expected = [result.reference?.file, result.line?.file, ...result.attempts.map(item => item.file)].filter((file): file is string => !!file);
  if (new Set(result.artifacts.map(item => item.file)).size !== result.artifacts.length || expected.some(file => !result.artifacts.some(item => item.file === file)) || Object.keys(files).some(file => file !== "result.json" && !result.artifacts.some(item => item.file === file))) throw new Error("Incomplete speech artifact manifest");
  console.log("[drama3SequenceTiming]", JSON.stringify({ job, phases: result.phases, setupSeconds: result.setupSeconds, sequenceSeconds: result.sequenceSeconds }));
  return { job, files, result };
}

export async function runDrama3(request: Parameters<ProviderTools["drama3"]>[0], signal?: AbortSignal) {
  const text = speechText(request.text, request.direction);
  if (request.reference && !request.reference.text.trim()) throw new Error("The voice reference needs its transcript");
  const job = crypto.randomUUID();
  const prefix = `drama3${job}`;
  const preparation = drama3Preparation();
  const reference = request.reference ? `${prefix}Reference.${inputExtension(request.reference.audio)}` : undefined;
  const referenceBytes = request.reference ? inputBytes(request.reference.audio) : undefined;
  if (referenceBytes && (!referenceBytes.length || referenceBytes.length > 100 * 1024 * 1024)) throw new Error("The voice reference must contain 1 byte–100 MB of audio");
  await waitForColabPreparation("drama3", signal);
  signal?.throwIfAborted();
  const [data, timings] = await worker.run((session, jobSignal) => session.job({
    script: pipeline,
    uploads: [
      { name: `${prefix}.json`, data: JSON.stringify({ text, reference, referenceMimeType: request.reference?.audio.mimeType, transcript: request.reference?.text }) },
      ...referenceBytes ? [{ name: reference!, data: referenceBytes }] : [],
    ],
    env: { DRAMA_JOB: prefix, DRAMA_RUNTIME: speechRuntime(), DRAMA_MODE: speechMode(), TOONFLOW_LOAD_ONLY: colabModelPrepared(colabLane(2), preparationKey(preparation)) ? 1 : 0 },
    outputs: [`/content/${prefix}.wav`, `/content/${prefix}Timings.json`],
    runtime: preparation.runtime,
  }, jobSignal), signal);
  console.log("[drama3Timing]", Buffer.from(timings!).toString("utf8"));
  return { data: data!, mimeType: "audio/wav" as const };
}
