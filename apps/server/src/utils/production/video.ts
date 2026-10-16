import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { fillDialogue, parseDialogue, speakerIds, videoPromptInstructions } from "@toonflow/node-shared/videoPrompt";
import { mkdir, readFile } from "@toonflow/file";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { stopMinimaxH3WhenIdle } from "@/utils/media/minimaxH3";
import { productionDirectory, writeProductionText, type Production } from "./state";

/**
 * `seed` is the seed the clip was rendered with, kept so a rerun after one change keeps the rest; `check` is the model's
 * verdict on its frames, `retried` marks a clip rendered again with a new seed after it failed, and `rejected` keeps the
 * verdict that sent it back.
 */
export type ProductionClip = {
  shot: number; prompt?: string; video?: string; seed?: number;
  check?: { issues: { problem: string; major: boolean }[]; passed: boolean }; retried?: boolean; rejected?: ProductionClip["check"];
};

const h3 = { providerId: "minimaxH3", modelId: "minimax_h3_ref2va" };
/**
 * How long a shot plays in the film: its time in the shot list, or longer when its lines need it. H3 renders whole
 * seconds of at least four, so the film cuts each clip to this.
 */
const shotSeconds = (production: Production, shot: number) => production.dub!.shots.find(item => item.shot === shot)!.seconds;
const mimeOf = (path: string) => /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.mp4$/i.test(path) ? "video/mp4" : /\.wav$/i.test(path) ? "audio/wav" : "image/png";

/**
 * Writes the MiniMax H3 prompt of every shot without one with the text model, saving each: the shared instructions, here
 * with the script and shot list inline, the keyframe's description for <Picture 1>, the previs as <Video 1> and the
 * dubbed track as <Audio 1>; the lines go in by fillDialogue. People are named by the trigger words their H3 LoRAs are
 * planned with, so the prompts need not wait for the training. A prompt whose line markers are wrong, that never names
 * a person by their LoRA's trigger word, or that gives one person's word to two, is rewritten once with the error.
 */
export async function writeClipPrompts(production: Production, script: string, shotList: string, complete: (prompt: string) => Promise<string>, save: () => Promise<void>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const ids = speakerIds(spans);
  const videos = production.videos ??= spans.map((span): ProductionClip => ({ shot: span.shot }));
  for (const span of spans) {
    const video = videos.find(item => item.shot === span.shot)!;
    if (video.prompt) continue;
    const clip = production.clips!.find(item => item.shot === span.shot)!.clip;
    const dubbed = !!production.dub!.shots.find(item => item.shot === span.shot)?.track;
    const keyframe = production.keyframes!.shots.find(item => item.shot === span.shot);
    // Everyone the previs shows at any moment of the shot, which the shot list's cast cell may leave out.
    const people = production.previs!.find(item => item.shot === span.shot)!.framed.shown;
    const loras = people.flatMap(name => {
      const trigger = production.assets!.characters.find(item => item.name === name)?.triggers?.h3;
      return trigger ? [{ name, trigger }] : [];
    });
    const kept = shotSeconds(production, span.shot);
    const cut = kept < clip ? `\n\nThe film keeps only the first ${kept.toFixed(1)} seconds of this clip, the shot's length: everything the row asks for happens within them, and afterwards the people hold still.` : "";
    const instructions = `${videoPromptInstructions(span, 1, { duration: clip, previs: true, dubbed, loras, keyframe: keyframe?.description, people }, ids)}${cut}\n\nOriginal script ({{ref 1}}):\n${script}\n\nShot list ({{ref 2}}):\n${shotList}`;
    // A person the prompt never names by their trigger word is drawn without their LoRA, as anyone, and a line put in
    // the mouth of someone described otherwise is spoken by the wrong person.
    const finish = (draft: string) => {
      const missing = loras.filter(lora => !draft.includes(lora.trigger));
      if (missing.length) throw new Error(`Name ${missing.map(lora => `${lora.name} as "${lora.trigger} woman" or "${lora.trigger} man"`).join(" and ")} every time they are mentioned`);
      // A trigger word before both "woman" and "man" gives one person's LoRA to two people.
      const shared = loras.filter(lora => new Set([...draft.matchAll(new RegExp(`\\b${lora.trigger}\\s+(woman|man)\\b`, "gi"))].map(match => match[1]!.toLowerCase())).size > 1);
      if (shared.length) throw new Error(`${shared.map(lora => `"${lora.trigger}" names ${lora.name} alone`).join(" and ")}: write it only for them, always followed by the same word, woman or man`);
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
    video.prompt = prompt;
    await save();
  }
}

/**
 * Renders each clip not rendered yet into `folder`, from its keyframe as the first frame, its previs as the blocking
 * reference, its dubbed track, the H3 LoRAs of everyone its previs shows and its own seed. All are requested at once
 * and run one after another on one Colab machine.
 */
export async function renderClips(cwd: string, production: Production, clips: ProductionClip[], resolution: "480p" | "720p" | "1080p", folder: string, signal: AbortSignal, save: () => Promise<void>) {
  try {
    await Promise.all(clips.filter(item => !item.video).map(async item => {
      const keyframe = production.keyframes!.shots.find(shot => shot.shot === item.shot)!;
      const previs = production.previs!.find(shot => shot.shot === item.shot)!;
      const track = production.dub!.shots.find(shot => shot.shot === item.shot)?.track;
      const loras = previs.framed.shown.flatMap(name => production.assets!.characters.find(person => person.name === name)?.loras?.filter(lora => lora.family === "h3") ?? []);
      const [video] = await generateMedia(cwd, "video", {
        ...h3, mode: "startFrameOptional", prompt: item.prompt!, duration: production.clips!.find(clip => clip.shot === item.shot)!.clip, resolution, ratio: production.input.ratio,
        generateAudio: true, outputDirectory: `${productionDirectory(production.id)}/${folder}`,
        firstFrame: { path: keyframe.image!, mimeType: mimeOf(keyframe.image!) },
        // ACT: The previs goes in as a reference video rather than a control video, as the shot nodes do; skipPrevis only
        // lifts the server's control-video gate, which the previs reference satisfies.
        skipPrevis: true,
        videos: previs.video ? [{ path: previs.video, mimeType: "video/mp4" }] : [],
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

/** Each clip as an input cut to its shot's length. */
const cutClips = (command: FfmpegCommand, production: Production, clips: ProductionClip[]) =>
  clips.reduce((current, clip) => current.input(clip.video!).inputOptions("-t", shotSeconds(production, clip.shot).toFixed(3)), command);

/**
 * Joins the clips in shot order, each cut to its shot's length, into the rough cut, re-encoded to one format so clips of
 * any source join cleanly.
 */
export async function joinRoughCut(cwd: string, production: Production, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const clips = [...production.videos!].sort((a, b) => a.shot - b.shot);
  const output = `${productionDirectory(production.id)}/roughCut.mp4`;
  const filters = [`${clips.map((_, index) => `[${index}:v][${index}:a]`).join("")}concat=n=${clips.length}:v=1:a=1[v][a]`];
  const command = cutClips(ffmpeg(), production, clips).complexFilter(filters, ["v", "a"])
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
 * Finishes the film from the final clips, or the rough cut's at 480p: joins them in shot order, each cut to its shot's
 * length, with each clip's sound at one loudness, lays the music under the dialogue and ducks it while people speak, as
 * the soundtrack mix node does, and burns in each dubbed line as a subtitle for as long as it is spoken.
 */
export async function finishFilm(cwd: string, production: Production, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const duration = (path: string) => new Promise<number>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(Number(data.format.duration) || 0)));
  const clips = [...production.finals ?? production.videos!].sort((a, b) => a.shot - b.shot);
  const lengths = await Promise.all(clips.map(async clip => Math.min(await duration(clip.video!), shotSeconds(production, clip.shot))));
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
    subtitles ? `[v]subtitles=filename=${subtitles}:force_style='FontSize=24,Outline=2,Shadow=1,MarginV=24'[picture]` : "[v]null[picture]",
    production.music
      ? `[${clips.length}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total},asetpts=PTS-STARTPTS,volume=${musicVolume},afade=t=in:d=2,afade=t=out:st=${Math.max(0, total - 3)}:d=3[bed];`
        + "[dialogue]asplit=2[voice][key];[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.95[sound]"
      : "[dialogue]alimiter=limit=0.95[sound]",
  ];
  const output = `${folder}/film.mp4`;
  const command = cutClips(ffmpeg(), production, clips);
  // The score repeats if it is shorter than the film; atrim cuts it to the film's length.
  if (production.music) command.input(production.music).inputOptions("-stream_loop", "-1");
  command.complexFilter(filters, ["picture", "sound"])
    .outputOptions(["-c:v libx264", "-crf 18", "-pix_fmt yuv420p", "-c:a aac", "-b:a 192k", "-movflags +faststart"]).output(output);
  await finished(command);
  return output;
}

// Frames a clip check reads, as shares of the part of the clip the film keeps.
const checkTimes = [0.1, 0.4, 0.7, 0.95];

/**
 * The keyframe and four frames of the part of a clip the film keeps as base64 PNGs, the frames saved beside the clips for
 * a person to see.
 */
export async function clipFrames(cwd: string, production: Production, clip: ProductionClip, keyframe: string, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const probed = await new Promise<number>((resolve, reject) => ffmpeg.ffprobe(clip.video!, (error, data) => error ? reject(error) : resolve(Number(data.format.duration) || 0)));
  const length = Math.min(probed, shotSeconds(production, clip.shot));
  const folder = `${productionDirectory(production.id)}/checks`;
  await mkdir((await resolveWorkspacePath(cwd, folder, true)).path, { recursive: true });
  // Everything is scaled to 640 px wide, which keeps the model's image reading short.
  const frames = [`${folder}/shot${clip.shot}Keyframe.png`];
  await finished(ffmpeg(keyframe).frames(1).outputOptions(["-vf scale=640:-2"]).output(frames[0]!));
  for (const [index, share] of checkTimes.entries()) {
    const frame = `${folder}/shot${clip.shot}Frame${index + 1}.png`;
    await finished(ffmpeg(clip.video!).seekInput(length * share).frames(1).outputOptions(["-vf scale=640:-2"]).output(frame));
    frames.push(frame);
  }
  return Promise.all(frames.map(async path => Buffer.from(await readFile((await resolveWorkspacePath(cwd, path)).path)).toString("base64")));
}

/**
 * Asks for every problem in a clip, each marked major or minor, as JSON. ACT: The model names problems well but scored
 * clips 85/92 whatever it found, a changed set and clothes included, so the verdict follows the problems it marks major.
 * The clip is judged against the keyframe image only: given the keyframe's written description as well, the model took
 * the words for the picture and failed every clip of the first production, natural movement included.
 */
export function clipCheckPrompt(prompt: string) {
  return [
    "The first image is a shot's keyframe, the first frame its video clip had to start from; the next four are frames from the clip at 10%, 40%, 70% and 95% of its length.",
    `The clip was asked for: ${prompt}`,
    "Compare the frames with the keyframe image, never with the words: they only tell you which movements and camera move were asked for, and where they describe the picture differently, the keyframe image is right.",
    "List every problem you see. A problem is major when the set, the light or someone's clothes, hair or face differ from the keyframe; the clip does not open on the keyframe's place, framing and people; someone who should be seen has their head or face out of frame; someone or something appears from nowhere, vanishes or jumps to another place; a face, hand or body melts or deforms; someone passes through furniture or another person; or the picture flickers or morphs. Anything smaller is minor, such as a small drift of the framing.",
    "Movement is what a clip is for: people turning, looking around, speaking, changing expression, gesturing, standing up, sitting down or walking, and a camera move such as a push in, pull back, pan or follow, are no problem as long as they carry on naturally from the keyframe's moment.",
    "Reply with JSON only: {\"issues\": [{\"problem\": \"what you saw, with the frame\", \"major\": true or false}]}, with an empty list when there is nothing wrong.",
  ].join("\n");
}

/** Reads the check's JSON: a clip passes without major problems; a reply that cannot be read fails rather than trusted. */
export function readClipCheck(reply: string): NonNullable<ProductionClip["check"]> {
  const unreadable = { issues: [{ problem: "The check's reply could not be read.", major: true }], passed: false };
  try {
    const value = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? "") as { issues?: unknown };
    if (!Array.isArray(value.issues)) return unreadable;
    const issues = value.issues.flatMap(item => item && typeof item === "object" && typeof (item as { problem?: unknown }).problem === "string"
      ? [{ problem: (item as { problem: string }).problem, major: (item as { major?: unknown }).major === true }] : []).slice(0, 10);
    return { issues, passed: !issues.some(item => item.major) };
  } catch {
    return unreadable;
  }
}

