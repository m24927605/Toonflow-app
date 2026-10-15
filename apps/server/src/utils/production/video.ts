import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { fillDialogue, parseDialogue, speakerIds, videoPromptInstructions } from "@toonflow/node-shared/videoPrompt";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { generateMedia } from "@/utils/media/generation";
import { stopMinimaxH3WhenIdle } from "@/utils/media/minimaxH3";
import { productionDirectory, writeProductionText, type Production } from "./state";

/** `seed` is the seed the clip was rendered with, kept so a rerun after one change keeps the rest. */
export type ProductionClip = { shot: number; prompt?: string; video?: string; seed?: number };

const h3 = { providerId: "minimaxH3", modelId: "minimax_h3_ref2va" };
const mimeOf = (path: string) => /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.mp4$/i.test(path) ? "video/mp4" : /\.wav$/i.test(path) ? "audio/wav" : "image/png";

/**
 * Writes every shot's MiniMax H3 prompt with the text model: the shared instructions, here with the script and shot
 * list inline, the keyframe's description for <Picture 1>, the previs as <Video 1> and the dubbed track as <Audio 1>; the
 * lines go in by fillDialogue. A prompt whose line markers are wrong, or that never names a person by their LoRA's
 * trigger word, is rewritten once with the error.
 */
export async function writeClipPrompts(production: Production, script: string, shotList: string, complete: (prompt: string) => Promise<string>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const ids = speakerIds(spans);
  const clips: ProductionClip[] = [];
  for (const span of spans) {
    const clip = production.clips!.find(item => item.shot === span.shot)!.clip;
    const dubbed = !!production.dub!.shots.find(item => item.shot === span.shot)?.track;
    const keyframe = production.keyframes!.shots.find(item => item.shot === span.shot);
    const people = keyframe?.cast ?? [];
    const loras = people.flatMap(name => {
      const lora = production.assets!.characters.find(item => item.name === name)?.loras?.find(item => item.family === "h3");
      return lora ? [{ name, trigger: lora.trigger }] : [];
    });
    const instructions = `${videoPromptInstructions(span, 1, { duration: clip, previs: true, dubbed, loras, keyframe: keyframe?.description }, ids)}\n\nOriginal script ({{ref 1}}):\n${script}\n\nShot list ({{ref 2}}):\n${shotList}`;
    // A person the prompt never names by their trigger word is drawn without their LoRA, as anyone, and a line put in
    // the mouth of someone described otherwise is spoken by the wrong person.
    const finish = (draft: string) => {
      const missing = loras.filter(lora => !draft.includes(lora.trigger));
      if (missing.length) throw new Error(`Name ${missing.map(lora => `${lora.name} as "${lora.trigger} woman" or "${lora.trigger} man"`).join(" and ")} every time they are mentioned`);
      for (const { speaker } of parseDialogue(span.dialogue)) {
        const lora = loras.find(item => item.name === speaker);
        const at = draft.indexOf(`(${ids.get(speaker ?? "")}) says`);
        // ACT: The speaker's description is taken as the 200 characters before their ID; a longer one fails this check.
        if (lora && at >= 0 && !draft.slice(Math.max(0, at - 200), at).includes(lora.trigger)) {
          throw new Error(`The line of ${speaker} must be said by "${lora.trigger} woman" or "${lora.trigger} man", described right before (${ids.get(speaker!)}) says`);
        }
      }
      return fillDialogue(draft, parseDialogue(span.dialogue));
    };
    let draft = await complete(instructions);
    let prompt: string;
    try {
      prompt = finish(draft);
    } catch (error) {
      draft = await complete(`${instructions}\n\nYour prompt:\n${draft}\n\nFix this and output the whole prompt again: ${error instanceof Error ? error.message : String(error)}`);
      prompt = finish(draft);
    }
    clips.push({ shot: span.shot, prompt });
  }
  return clips;
}

/**
 * Renders each clip not rendered yet into `folder`, from its keyframe as the first frame, its previs as the blocking
 * reference, its dubbed track, its cast's H3 LoRAs and its own seed. All are requested at once and run one after
 * another on one Colab machine.
 */
export async function renderClips(cwd: string, production: Production, clips: ProductionClip[], resolution: "480p" | "720p" | "1080p", folder: string, signal: AbortSignal, save: () => Promise<void>) {
  try {
    await Promise.all(clips.filter(item => !item.video).map(async item => {
      const keyframe = production.keyframes!.shots.find(shot => shot.shot === item.shot)!;
      const previs = production.previs!.find(shot => shot.shot === item.shot);
      const track = production.dub!.shots.find(shot => shot.shot === item.shot)?.track;
      const loras = keyframe.cast.flatMap(name => production.assets!.characters.find(person => person.name === name)?.loras?.filter(lora => lora.family === "h3") ?? []);
      const [video] = await generateMedia(cwd, "video", {
        ...h3, mode: "startFrameOptional", prompt: item.prompt!, duration: production.clips!.find(clip => clip.shot === item.shot)!.clip, resolution, ratio: production.input.ratio,
        generateAudio: true, outputDirectory: `${productionDirectory(production.id)}/${folder}`,
        firstFrame: { path: keyframe.image!, mimeType: mimeOf(keyframe.image!) },
        // ACT: The previs goes in as a reference video rather than a control video, as the shot nodes do; skipPrevis only
        // lifts the server's control-video gate, which the previs reference satisfies.
        skipPrevis: true,
        videos: previs ? [{ path: previs.video, mimeType: "video/mp4" }] : [],
        audios: track ? [{ path: track, mimeType: "audio/wav" }] : [],
        loras: loras.map(lora => ({ path: lora.path, strength: 1 })), seed: item.seed,
      }, signal);
      item.video = video!.path;
      item.seed = video!.seed;
      await save();
    }));
  } finally {
    // These are all the clips the production has to render, so the A100 stops when they are done rather than idling on.
    stopMinimaxH3WhenIdle();
  }
}

const finished = (command: FfmpegCommand) => new Promise<void>((resolve, reject) => command.on("end", () => resolve()).on("error", reject).run());

/** Joins the clips in shot order into the rough cut, re-encoded to one format so clips of any source join cleanly. */
export async function joinRoughCut(cwd: string, production: Production, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const clips = [...production.videos!].sort((a, b) => a.shot - b.shot).map(item => item.video!);
  const output = `${productionDirectory(production.id)}/roughCut.mp4`;
  const filters = [`${clips.map((_, index) => `[${index}:v][${index}:a]`).join("")}concat=n=${clips.length}:v=1:a=1[v][a]`];
  const command = clips.reduce((current, clip) => current.input(clip), ffmpeg()).complexFilter(filters, ["v", "a"])
    .outputOptions(["-c:v libx264", "-crf 18", "-pix_fmt yuv420p", "-c:a aac", "-b:a 192k", "-movflags +faststart"]).output(output);
  await finished(command);
  return output;
}

/** Has Suno V6 compose an instrumental score from `style` for the film's length; it bills the sunoapi.org account. */
export async function scoreFilm(cwd: string, production: Production, style: string, seconds: number, signal: AbortSignal) {
  const [music] = await generateMedia(cwd, "audio", {
    providerId: "suno", modelId: "V6", prompt: style.slice(0, 1000), duration: Math.min(360, Math.max(10, Math.ceil(seconds))),
    outputDirectory: `${productionDirectory(production.id)}/music`,
  }, signal);
  return music!.path;
}

// Clips with dialogue are brought to one loudness, so lines keep one level across shots; a clip without lines keeps its
// quiet ambience, which normalising would raise as loud as speech. The music sits well under the dialogue.
const dialogueLoudness = "loudnorm=I=-16:TP=-1.5:LRA=11";
const musicVolume = 0.35;

/** One SRT time stamp, such as 00:01:02,345. */
function srtTime(seconds: number) {
  const milliseconds = Math.round(seconds * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(milliseconds / 3_600_000))}:${pad(Math.floor(milliseconds / 60_000) % 60)}:${pad(Math.floor(milliseconds / 1000) % 60)},${pad(milliseconds % 1000, 3)}`;
}

/**
 * Finishes the film from the final clips, or the rough cut's at 480p: joins them in shot order with each clip's sound
 * at one loudness, lays the music under the dialogue and ducks it while people speak, as the soundtrack mix node does,
 * and burns in each dubbed line as a subtitle for as long as it is spoken.
 */
export async function finishFilm(cwd: string, production: Production, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const duration = (path: string) => new Promise<number>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(Number(data.format.duration) || 0)));
  const clips = [...production.finals ?? production.videos!].sort((a, b) => a.shot - b.shot);
  const lengths = await Promise.all(clips.map(clip => duration(clip.video!)));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const folder = productionDirectory(production.id);
  let subtitles: string | undefined;
  if (production.input.subtitles) {
    let offset = 0;
    const entries = clips.flatMap((clip, index) => {
      const start = offset;
      offset += lengths[index]!;
      return (production.dub!.shots.find(shot => shot.shot === clip.shot)?.lines ?? []).flatMap(line => line.start === undefined || !line.seconds ? []
        : [{ from: start + line.start, to: Math.min(start + line.start + line.seconds, offset), words: line.words }]);
    });
    if (entries.length) {
      subtitles = `${folder}/subtitles.srt`;
      const text = entries.map((entry, index) => `${index + 1}\n${srtTime(entry.from)} --> ${srtTime(entry.to)}\n${entry.words}\n`).join("\n");
      await writeProductionText(cwd, subtitles, text);
    }
  }
  const filters = [
    ...clips.map((clip, index) => {
      const spoken = !!production.dub!.shots.find(shot => shot.shot === clip.shot)?.lines.length;
      return `[${index}:a]${spoken ? `${dialogueLoudness},` : ""}aresample=48000,aformat=channel_layouts=stereo[a${index}]`;
    }),
    `${clips.map((_, index) => `[${index}:v][a${index}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][dialogue]`,
    // The subtitle file sits in the production folder, a path of plain characters relative to the workspace FFmpeg runs in.
    subtitles ? `[v]subtitles=filename=${subtitles}:force_style='FontSize=18,Outline=1,Shadow=0,MarginV=20'[picture]` : "[v]null[picture]",
    production.music
      ? `[${clips.length}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total},asetpts=PTS-STARTPTS,volume=${musicVolume},afade=t=in:d=2,afade=t=out:st=${Math.max(0, total - 3)}:d=3[bed];`
        + "[dialogue]asplit=2[voice][key];[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.95[sound]"
      : "[dialogue]alimiter=limit=0.95[sound]",
  ];
  const output = `${folder}/film.mp4`;
  const command = clips.reduce((current, clip) => current.input(clip.video!), ffmpeg());
  // The score repeats if it is shorter than the film; atrim cuts it to the film's length.
  if (production.music) command.input(production.music).inputOptions("-stream_loop", "-1");
  command.complexFilter(filters, ["picture", "sound"])
    .outputOptions(["-c:v libx264", "-crf 18", "-pix_fmt yuv420p", "-c:a aac", "-b:a 192k", "-movflags +faststart"]).output(output);
  await finished(command);
  return output;
}

