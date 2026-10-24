import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeAtomic } from "@toonflow/file";
import { checkScript, retimeScript } from "@toonflow/node-shared/scriptCheck";
import { z } from "zod";
import { castNames, shotSpans } from "@toonflow/node-shared/shotList";
import { parseDialogue } from "@toonflow/node-shared/videoPrompt";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { runDrama3Sequence } from "@/utils/media/drama3";
import { maxTakeSeconds } from "@/utils/media/sulphur";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { readPlan, type ProductionPlan } from "./plan";
import { productionDirectory, readProduction, type Production } from "./state";

// Sulphur 2 renders whole seconds, up to 20 in one part and up to 120 as a long take in parts; the film cuts each clip to
// its shot's length.
export const clipSeconds = (seconds: number) => Math.min(maxTakeSeconds, Math.max(1, Math.ceil(seconds)));
// Trim boundary silence so pauses and subtitles follow the spoken words; -50 dB preserves soft word endings.
const trimSilence = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse";
export const dialogueLoudness = "loudnorm=I=-16:TP=-1.5:LRA=11";

/**
 * The longest a line's recording may run: twice its speaking time, at about 4 letters a second for Chinese, Japanese or
 * Korean and 12 for other languages, plus a second of breath, and never past the film; punctuation is not spoken. The
 * speech model sometimes keeps voicing a short cry for many seconds; the recording is cut at this limit instead.
 */
function lineLimit(words: string, filmSeconds: number) {
  const letters = words.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  return Math.min(filmSeconds, 1 + 2 * letters / (/[぀-ヿ㐀-鿿가-힯]/.test(words) ? 4 : 12));
}

type AudioAttempt = { path: string; seconds: number; reason: string; at: string };
export type ProductionDub = {
  /** A generated reference anchors later lines; sound quality is not AI-reviewed. */
  voices: Record<string, { presentation: "feminine" | "masculine" | "androgynous"; description: string; language: string; sample: string; candidate?: string; attempts?: AudioAttempt[]; reference?: { path: string; text: string } }>;
  /** `start` is when a line begins in its shot's track, which the film's subtitles follow. */
  shots: { shot: number; seconds: number; lines: { speaker: string; words: string; path?: string; seconds?: number; start?: number; attempts?: AudioAttempt[] }[]; track?: string }[];
};

export class DialogueTimingError extends Error {}
export const dialogueTimingSchema = z.array(z.strictObject({ shot: z.number().int().positive(), seconds: z.number().finite().positive(), starts: z.array(z.number().finite().nonnegative()) })).min(1);

/** Reconciles measured speech with the fixed film length without rewriting actions or processing the voice. */
export function applyDialogueTiming(production: Production, script: string, shotList: string, reply: unknown) {
  const timing = dialogueTimingSchema.parse(reply);
  const dub = production.dub!;
  if (timing.length !== dub.shots.length || Math.abs(timing.reduce((sum, shot) => sum + shot.seconds, 0) - production.input.seconds) > 0.000001) throw new Error("Dialogue timing must preserve the requested film duration and every shot");
  for (const [index, shot] of dub.shots.entries()) {
    const next = timing[index]!;
    if (next.shot !== shot.shot || next.starts.length !== shot.lines.length) throw new Error("Dialogue timing changed shot or line order");
    for (const [lineIndex, line] of shot.lines.entries()) {
      const start = next.starts[lineIndex]!;
      if (!line.path || !Number.isFinite(line.seconds) || line.seconds! <= 0 || start + line.seconds! > next.seconds || lineIndex > 0 && start < next.starts[lineIndex - 1]! + shot.lines[lineIndex - 1]!.seconds!) throw new Error("Measured dialogue must fit without overlap or truncation");
    }
  }
  const updated = retimeScript(shotList, timing.map(shot => shot.seconds));
  const checked = checkScript(updated, production.input.seconds);
  if (checked.issues.length) throw new Error("Revised dialogue timing violates the shot-list requirements");
  const contract = production.plan!;
  const plan = readPlan(JSON.stringify({ voices: contract.voices, shots: contract.shots.map((shot, index) => ({ ...shot, lines: shot.lines.map((line, lineIndex) => ({ ...line, start: timing[index]!.starts[lineIndex]! })) })) }), script, updated, production.assets!);
  const revised = planDub(updated, production.assets!, plan);
  revised.voices = dub.voices;
  for (const [index, shot] of revised.shots.entries()) for (const [lineIndex, line] of shot.lines.entries()) {
    const recorded = dub.shots[index]!.lines[lineIndex]!;
    Object.assign(line, { path: recorded.path, seconds: recorded.seconds, attempts: recorded.attempts });
    if (line.start! + line.seconds! > shot.seconds + 0.000001) throw new Error("Rounded shot timing cannot contain its dialogue");
  }
  production.plan = plan;
  production.dub = revised;
  production.shotList!.issues = checked.issues;
  return updated;
}

/**
 * A timing that holds every measured line, in tenths of a second: each shot keeps its length unless its lines need
 * more, read one after another from a quarter second in, and the time a grown shot takes comes from the shots with the
 * most to spare. Undefined when the recordings cannot fit the film at all.
 */
export function fitDialogueTiming(production: Production) {
  const lead = 0.25;
  const shots = production.dub!.shots;
  const total = Math.round(production.input.seconds * 10);
  const least = shots.map(shot => Math.max(10, Math.ceil((lead + shot.lines.reduce((sum, line) => sum + line.seconds!, 0)) * 10 - 1e-6)));
  if (least.reduce((sum, value) => sum + value, 0) > total) return undefined;
  const tenths = shots.map((shot, index) => Math.max(Math.round(shot.seconds * 10), least[index]!));
  const spare = () => tenths.reduce((best, value, index) => value - least[index]! > tenths[best]! - least[best]! ? index : best, 0);
  for (let over = tenths.reduce((sum, value) => sum + value, 0) - total; over > 0; over--) tenths[spare()]!--;
  for (let under = total - tenths.reduce((sum, value) => sum + value, 0); under > 0; under--) tenths[spare()]!++;
  return shots.map((shot, index) => {
    let start = lead;
    return { shot: shot.shot, seconds: tenths[index]! / 10, starts: shot.lines.map(line => {
      const at = start;
      start += line.seconds!;
      return at;
    }) };
  });
}

/** Plans dialogue and auditions from the validated production contract. */
export function planDub(shotList: string, assets: NonNullable<Production["assets"]>, plan: ProductionPlan): ProductionDub {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const dubVoices: ProductionDub["voices"] = Object.fromEntries(plan.voices.map(({ name, ...voice }) => [name, voice]));
  return {
    voices: dubVoices,
    shots: spans.map(span => ({
      shot: span.shot, seconds: span.end - span.start,
      lines: parseDialogue(span.dialogue).map((line, index) => {
        const cast = castNames(span).filter(name => dubVoices[name]);
        const speaker = line.speaker || (cast.length === 1 ? cast[0] : undefined);
        if (!speaker || !dubVoices[speaker] || !assets.characters.some(person => person.name === speaker)) throw new Error(`Shot ${span.shot}: dialogue needs a known, unambiguous speaker`);
        const planned = plan.shots.find(shot => shot.shot === span.shot)?.lines;
        const timing = planned?.[index];
        if (!timing || timing.speaker !== speaker || timing.words !== line.words) throw new Error(`Shot ${span.shot}: missing or mismatched dialogue contract`);
        return { speaker, words: line.words, start: timing.start };
      }),
    })),
  };
}

const finished = (command: FfmpegCommand) => new Promise<void>((resolve, reject) => command.on("end", () => resolve()).on("error", reject).run());

/** Reuse exact same-project voice designs; cross-project reuse additionally requires a matching photograph. */
export async function reuseVoices(cwd: string, production: Production) {
  if (production.execution?.reuseDesigns.mode === "new") return;
  if (production.execution?.reuseDesigns.mode === "matching") for (const [name, voice] of Object.entries(production.dub!.voices)) {
    const prior = production.previousDub?.voices[name];
    const person = production.assets!.characters.find(item => item.name === name);
    const original = production.previousAssets?.characters.find(item => item.name === name);
    if (voice.reference || voice.candidate || !prior?.reference || !person || !original || person.look !== original.look || person.photo !== original.photo || prior.presentation !== voice.presentation || prior.description !== voice.description || prior.language !== voice.language) continue;
    if (person.photo && createHash("sha256").update(await readFile((await resolveWorkspacePath(cwd, person.photo)).path)).digest("hex") !== original.photoSha256) continue;
    const present = await resolveWorkspacePath(cwd, prior.reference.path).then(file => readFile(file.path)).then(() => true, () => false);
    if (present) voice.reference = { ...prior.reference };
  }
  const voices = Object.entries(production.dub!.voices).filter(([name, voice]) => !voice.reference && !voice.candidate && production.assets!.characters.some(item => item.name === name && item.photo));
  if (!voices.length) return;
  const folder = (await resolveWorkspacePath(cwd, productionDirectory(""), true)).path;
  const ids = (await readdir(folder)).filter(id => id !== production.id);
  const earlier = (await Promise.all(ids.map(id => readProduction(cwd, id).catch(() => undefined)))).filter(item => item?.dub).sort((a, b) => b!.updatedAt.localeCompare(a!.updatedAt));
  const bytes = async (path: string) => readFile((await resolveWorkspacePath(cwd, path)).path);
  for (const [name, voice] of voices) {
    const person = production.assets!.characters.find(item => item.name === name);
    if (!person?.photo) continue;
    const photoHash = createHash("sha256").update(await bytes(person.photo)).digest("hex");
    for (const other of earlier) {
      const old = other!.dub!.voices[name];
      if (!old?.reference || old.presentation !== voice.presentation || old.description !== voice.description || old.language !== voice.language) continue;
      const original = other!.assets?.characters.find(item => item.name === name)?.photo;
      if (!original) continue;
      const match = await Promise.all([bytes(original), bytes(old.reference.path)]).then(([photo]) => createHash("sha256").update(photo!).digest("hex") === photoHash, () => false);
      if (!match) continue;
      voice.reference = { ...old.reference };
      break;
    }
  }
}

/** Reads every line aloud, then joins each shot's lines into one track with short pauses; returns the shots' clip lengths. */
export async function recordDub(cwd: string, production: Production, signal: AbortSignal, save: () => Promise<void>, ready: (shot: number) => void) {
  const dub = production.dub!;
  for (const spec of production.plan?.voices ?? []) {
    const voice = dub.voices[spec.name];
    if (!voice || voice.presentation !== spec.presentation || voice.description !== spec.description || voice.language !== spec.language || voice.sample !== spec.sample) throw new Error(`Voice design changed for ${spec.name}; rebuild its audition and dialogue before continuing`);
  }
  await reuseVoices(cwd, production);
  await save();
  const folder = `${productionDirectory(production.id)}/dub`;
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  await mkdir((await resolveWorkspacePath(cwd, folder, true)).path, { recursive: true });
  production.clips ??= [];
  const mixing = Array.from({ length: 3 }, () => Promise.resolve());
  let nextMix = 0;
  const speaking = new Map<string, Promise<void>>();
  const results = await Promise.allSettled(dub.shots.map(async shot => {
    const canonical = production.plan?.shots.find(item => item.shot === shot.shot);
    if (!canonical || canonical.lines.length !== shot.lines.length || shot.lines.some((line, index) => {
      const expected = canonical.lines[index]!;
      return line.speaker !== expected.speaker || line.words !== expected.words || line.start !== expected.start || !Number.isFinite(line.start) || line.start! < 0 || line.start! >= shot.seconds;
    })) throw new Error(`Shot ${shot.shot}: dialogue differs from its authoritative contract; rebuild it before recording`);
    const lines = await Promise.allSettled(shot.lines.filter(line => !line.path).map(line => {
      const next = (speaking.get(line.speaker) ?? Promise.resolve()).catch(error => {
        if (!dub.voices[line.speaker]?.reference) throw error;
      }).then(async () => {
        const voice = dub.voices[line.speaker]!;
        if (!voice?.presentation || !voice.description?.trim() || !voice.language?.trim() || !voice.sample?.trim()) throw new Error(`Missing voice design for ${line.speaker}; rebuild the production contract`);
        const limit = lineLimit(line.words, production.input.seconds);
        const recorded = line.attempts?.find(attempt => attempt.seconds > 0 && attempt.seconds <= limit);
        if (recorded && voice.reference) {
          Object.assign(line, { path: recorded.path, seconds: recorded.seconds });
          await save();
          return;
        }
        const direction = `${voice.presentation} voice. ${voice.description} Speak in ${voice.language}.`;
        const reference = voice.reference ? { audio: { type: "binary" as const, data: new Uint8Array(await readFile((await resolveWorkspacePath(cwd, voice.reference.path)).path)), mimeType: "audio/wav" }, text: voice.reference.text } : undefined;
        const sequence = await runDrama3Sequence({ voiceText: voice.sample, voiceTranscript: voice.sample, lineText: line.words, direction, filters: [trimSilence, dialogueLoudness], referenceAttempts: Math.max(0, 2 - (voice.attempts?.length ?? 0)), lineAttempts: Math.max(0, 2 - (line.attempts?.length ?? 0)), maximumLineSeconds: limit, reference }, signal);
        const paths = new Map<string, string>();
        for (const artifact of sequence.result.artifacts) {
          const name = artifact.file[0]!.toUpperCase() + artifact.file.slice(1);
          const target = `${folder}/${sequence.job}${name}`;
          await writeAtomic((await resolveWorkspacePath(cwd, target, true)).path, sequence.files[artifact.file]!, { exclusive: true });
          paths.set(artifact.file, target);
        }
        for (const attempt of sequence.result.attempts) {
          const record = { path: paths.get(attempt.file)!, seconds: attempt.seconds, reason: attempt.reason, at: new Date().toISOString() };
          if (attempt.kind === "reference") (voice.attempts ??= []).push(record);
          else (line.attempts ??= []).push(record);
        }
        if (!voice.reference && sequence.result.reference) voice.reference = { path: paths.get(sequence.result.reference.file)!, text: sequence.result.reference.text };
        if (sequence.result.line) Object.assign(line, { path: paths.get(sequence.result.line.file)!, seconds: sequence.result.line.seconds });
        await save();
        if (!line.path) throw new Error(sequence.result.error || `Shot ${shot.shot}: no valid dialogue recording returned`);
      });
      speaking.set(line.speaker, next);
      return next;
    }));
    const failure = lines.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  if (dub.shots.some(shot => shot.lines.some((line, index) => !Number.isFinite(line.seconds) || line.seconds! <= 0 || line.start! + line.seconds! > shot.seconds || index > 0 && line.start! < shot.lines[index - 1]!.start! + shot.lines[index - 1]!.seconds!))) throw new DialogueTimingError("Recorded dialogue needs revised shot timing");
  const mixedShots = await Promise.allSettled(dub.shots.map(async shot => {
    const index = nextMix++ % mixing.length;
    const mixed = mixing[index]!.then(async () => {
      signal.throwIfAborted();
      if (shot.lines.length) {
        const track = `${folder}/shot${shot.shot}.wav`;
        const inputs = shot.lines.map(line => line.path!);
        const delays = shot.lines.map((line, index) => {
          const previous = shot.lines[index - 1];
          if (!Number.isFinite(line.start) || !Number.isFinite(line.seconds) || line.start! < 0 || line.start! + line.seconds! > shot.seconds || previous && line.start! < previous.start! + previous.seconds!) throw new Error(`Shot ${shot.shot}: dialogue overlaps or exceeds the contracted shot length`);
          return line.start!;
        });
        // The track runs the whole clip, silence after the last line, since the clip locks it as its complete soundtrack.
        const filters = [
          ...delays.map((start, index) => `[${index}:a]aresample=48000,adelay=${Math.round(start * 1000)}:all=1[l${index}]`),
          `${delays.map((_, index) => `[l${index}]`).join("")}amix=inputs=${delays.length}:normalize=0,apad=whole_dur=${clipSeconds(shot.seconds)}[out]`,
        ];
        const command = inputs.reduce((current, input) => current.input(input), ffmpeg()).complexFilter(filters, "out").audioChannels(2).output(track);
        await finished(command);
        shot.track = track;
      }
      const clip = { shot: shot.shot, clip: clipSeconds(shot.seconds) };
      const existing = production.clips!.find(item => item.shot === shot.shot);
      if (existing) existing.clip = clip.clip;
      else production.clips!.push(clip);
      production.clips!.sort((a, b) => a.shot - b.shot);
      await save();
      ready(shot.shot);
    });
    mixing[index] = mixed.catch(() => {});
    await mixed;
  }));
  const mixedFailure = mixedShots.find(result => result.status === "rejected");
  if (mixedFailure) throw mixedFailure.reason;
  return production.clips;
}
