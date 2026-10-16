import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { parseDialogue } from "@toonflow/node-shared/videoPrompt";
import { t } from "@/lib/i18n";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { generateMedia } from "@/utils/media/generation";
import { productionDirectory, type Production } from "./state";

const tts = { providerId: "gemini", modelId: "gemini-3.8-flash-tts" };
// ACT: Gemini's prebuilt voices by the sex Google describes them with; people take the next unused one of theirs, so
// each keeps one distinct voice. Pick by the cast's voice description instead if two voices of a sex ever clash.
const voices = {
  female: ["Kore", "Leda", "Aoede", "Callirrhoe", "Autonoe", "Despina", "Erinome", "Laomedeia", "Achernar", "Gacrux", "Pulcherrima", "Vindemiatrix", "Sulafat", "Zephyr"],
  male: ["Charon", "Puck", "Fenrir", "Orus", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Algenib", "Rasalgethi", "Alnilam", "Schedar", "Achird", "Zubenelgenubi", "Sadachbia", "Sadaltager"],
};
// Silence before the first line and between lines of one shot, in seconds.
const lead = 0.3;
const gap = 0.3;
// MiniMax H3 renders whole seconds from 4 to 15.
const clipSeconds = (seconds: number) => Math.min(15, Math.max(4, Math.ceil(seconds)));
// Gemini pads each line with about a third of a second of near silence at both ends; it is cut off, so the pauses above
// and the subtitles follow the spoken words. -50 dB keeps the soft start of a word and a trailing breath.
const trimSilence = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse";

export type ProductionDub = {
  /** Each speaking person's Gemini voice and the delivery the cast description gives them. */
  voices: Record<string, { voice: string; style: string }>;
  /** `start` is when a line begins in its shot's track, which the film's subtitles follow. */
  shots: { shot: number; seconds: number; lines: { speaker: string; words: string; path?: string; seconds?: number; start?: number }[]; track?: string }[];
};

/** Plans the lines of every shot and gives each speaker a voice: female or male by their look, distinct per person. */
export function planDub(shotList: string, assets: NonNullable<Production["assets"]>): ProductionDub {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const used = new Set<string>();
  const dubVoices: ProductionDub["voices"] = {};
  for (const person of assets.characters) {
    const female = /\b(woman|girl|female|lady|she)\b/i.test(person.look);
    const voice = (female ? voices.female : voices.male).find(item => !used.has(item)) ?? (female ? voices.female : voices.male)[0]!;
    used.add(voice);
    dubVoices[person.name] = { voice, style: `${person.look}; natural, intimate film acting, not a narrator` };
  }
  return {
    voices: dubVoices,
    shots: spans.map(span => ({
      shot: span.shot, seconds: span.end - span.start,
      // A line without a speaker belongs to the first person of the shot's cast, or else the first person at all.
      lines: parseDialogue(span.dialogue).map(line => ({ speaker: line.speaker && dubVoices[line.speaker] ? line.speaker : Object.keys(dubVoices)[0]!, words: line.words })),
    })),
  };
}

const finished = (command: FfmpegCommand) => new Promise<void>((resolve, reject) => command.on("end", () => resolve()).on("error", reject).run());

/** Reads every line aloud, then joins each shot's lines into one track with short pauses; returns the shots' clip lengths. */
export async function recordDub(cwd: string, production: Production, signal: AbortSignal, save: () => Promise<void>) {
  const dub = production.dub!;
  const folder = `${productionDirectory(production.id)}/dub`;
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const duration = (path: string) => new Promise<number>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(Number(data.format.duration) || 0)));
  await Promise.all(dub.shots.flatMap(shot => shot.lines.filter(line => !line.path).map(async line => {
    const { voice, style } = dub.voices[line.speaker]!;
    // A line Gemini refuses fails the whole dub, so the error names the line along with Gemini's reason.
    const [audio] = await generateMedia(cwd, "audio", { ...tts, prompt: line.words, voice, emotion: style, format: "wav", outputDirectory: folder }, signal).catch((error: unknown) => {
      throw new Error(t`Shot ${shot.shot}, line ${shot.lines.indexOf(line) + 1} (${line.speaker}) could not be voiced: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    const spoken = `${audio!.path.replace(/\.[^./]+$/, "")}Spoken.wav`;
    await finished(ffmpeg(audio!.path).audioFilters(trimSilence).output(spoken));
    line.path = spoken;
    line.seconds = await duration(line.path);
  })));
  await save();
  for (const shot of dub.shots.filter(item => item.lines.length && !item.track)) {
    const track = `${folder}/shot${shot.shot}.wav`;
    const inputs = shot.lines.map(line => line.path!);
    // Each line is delayed to its place after the lead and the lines before it, then all are mixed into one track.
    let at = lead;
    const delays = shot.lines.map(line => {
      line.start = at;
      at += line.seconds! + gap;
      return line.start;
    });
    shot.seconds = Math.max(shot.seconds, at + lead);
    // The track runs the whole clip, silence after the last line, since H3 takes it as the clip's complete soundtrack.
    const filters = [
      ...delays.map((start, index) => `[${index}:a]aresample=48000,adelay=${Math.round(start * 1000)}:all=1[l${index}]`),
      `${delays.map((_, index) => `[l${index}]`).join("")}amix=inputs=${delays.length}:normalize=0,apad=whole_dur=${clipSeconds(shot.seconds)}[out]`,
    ];
    const command = inputs.reduce((current, input) => current.input(input), ffmpeg()).complexFilter(filters, "out").audioChannels(2).output(track);
    await finished(command);
    shot.track = track;
    await save();
  }
  return dub.shots.map(shot => ({ shot: shot.shot, clip: clipSeconds(shot.seconds) }));
}
