import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { fillDialogue, parseDialogue, referenceVideoPromptInstructions, speakerIds } from "@toonflow/node-shared/videoPrompt";
import { mkdir, readFile } from "@toonflow/file";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { longTakeParts, stopMinimaxH3WhenIdle } from "@/utils/media/minimaxH3";
import { correctionNote, lessonsOf, promptReview, readReview, ReplyCutError, replyJson, reviewRounds, type ClipDiagnosis } from "./review";
import { maxLoras, referenceImages, shotReferences } from "./shots";
import type { ProductionDub } from "./dub";
import { productionDirectory, writeProductionText, type Production } from "./state";

/**
 * The model's verdict on a clip's frames; `overruled` says why a diagnosis passed a clip whose every major problem was
 * the check's own mistake, and `unreadable` marks a reply that could not be read.
 */
export type ClipCheck = { issues: { problem: string; major: boolean }[]; passed: boolean; overruled?: string; unreadable?: boolean };

/**
 * `seed` is the seed the clip was rendered with, kept so a rerun after one change keeps the rest; `check` is the model's
 * verdict on its frames; `attempts` keeps every earlier render that failed, with its prompt and diagnosis, which the
 * prompt written next learns from. A shot longer than one render is a long take: `parts` holds the prompt of each
 * part, and `prompt` all of them, for the clip check.
 */
export type ProductionClip = {
  shot: number; prompt?: string; parts?: string[]; video?: string; seed?: number; check?: ClipCheck;
  attempts?: { prompt: string; parts?: string[]; video: string; seed?: number; check: ClipCheck; diagnosis: ClipDiagnosis }[];
};

const h3 = { providerId: "minimaxH3", modelId: "minimax_h3_ref2va" };
/**
 * How long a shot plays in the film: its time in the shot list, or longer when its lines need it. H3 renders whole
 * seconds of at least four, so the film cuts each clip to this.
 */
const shotSeconds = (production: Production, shot: number) => production.dub!.shots.find(item => item.shot === shot)!.seconds;
// Wording that sends someone's eyes into the lens, which the video model then draws, or names the lens at all, which
// draws them there too; allowed only when the row asks
// for that look ("\u770b"/"\u76ef"/"\u6ce8\u8996"/"\u76f4\u8996" "\u93e1\u982d"/"\u30ab\u30e1\u30e9" is "looks at the
// camera"). "Camera left" and "the camera's" are sides and things of the frame, not the lens.
const lensAt = /\b(?:looks?|looking|gaz(?:e|es|ed|ing)|stares?|stared|staring|glanc(?:e|es|ed|ing)|eyes)\b(?![-\s]level)[^.;:,|]{0,15}?\b(?:into|at|on|to|toward|towards)\s+(?:the\s+)?(?:camera|lens|viewer)\b(?!['\u2019]s\b|\s+(?:left|right)\b)/i;
const lensLook = new RegExp(`${lensAt.source}|\\b(?:looks?|looking|gaz(?:e|es|ed|ing)|eyes|stares?|staring)\\s+(?:\\w+\\s+)?(?:forward|ahead)\\b|\\blens(?:es)?\\b`, "i");
const lensRow = new RegExp(`${lensAt.source}|\\bbreak\\w*\\s+the\\s+fourth\\s+wall\\b|(?:\u770b|\u76ef|\u6ce8\u8996|\u6ce8\u89c6|\u76f4\u8996|\u76f4\u89c6)[\u5411\u7740\u8457]?(?:\u93e1\u982d|\u955c\u5934|\u30ab\u30e1\u30e9)|\u30ab\u30e1\u30e9\u76ee\u7dda`, "i");
const mimeOf = (path: string) => /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.mp4$/i.test(path) ? "video/mp4" : /\.wav$/i.test(path) ? "audio/wav" : "image/png";

/**
 * Writes the MiniMax H3 prompt of every shot without one with the text model, saving each, in full-reference mode: the
 * shared instructions, here with the script and shot list inline, the people the previs shows and the place as
 * <Picture N>, the previs as <Video 1> and the dubbed track as <Audio 1>; the lines go in by fillDialogue. People are named by the trigger words their H3 LoRAs are
 * planned with, so the prompts need not wait for the training. A prompt whose line markers are wrong, that never names
 * a person by their LoRA's trigger word, that gives one person's word to two, that writes a name from the script, or
 * that sends someone's eyes into the lens when the row does not ask for it, is rewritten with the error, twice at
 * most. Every prompt is then reviewed and rewritten for the faults that made clips fail before it costs GPU time; a
 * shot rendered before is written knowing what failed and why, and every prompt follows the lessons the film learned so
 * far.
 */
export async function writeClipPrompts(production: Production, script: string, shotList: string, complete: (prompt: string) => Promise<string>, save: () => Promise<void>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const ids = speakerIds(spans);
  const videos = production.videos ??= spans.map((span): ProductionClip => ({ shot: span.shot }));
  const names = production.assets!.characters.map(person => person.name);
  // Shots are written side by side, as the text model answers two requests at once, and so are a long take's parts.
  // Every shot is awaited before an error is passed on, so none goes on writing unwatched.
  const results = await Promise.allSettled(spans.map(async span => {
    const video = videos.find(item => item.shot === span.shot)!;
    if (video.prompt) return;
    const clip = production.clips!.find(item => item.shot === span.shot)!.clip;
    const dubbed = !!production.dub!.shots.find(item => item.shot === span.shot)?.track;
    const shot = production.shots!.find(item => item.shot === span.shot)!;
    const previs = production.previs!.find(item => item.shot === span.shot)!;
    // Everyone the previs shows at any moment of the shot, which the shot list's cast cell may leave out.
    const references = shotReferences(shot, production.assets!, previs.framed);
    const loras = references.people.flatMap(({ person }) => person.triggers?.h3 ? [{ name: person.name, trigger: person.triggers.h3 }] : []).slice(0, maxLoras);
    const people = references.people.map(({ person }) => ({ name: person.name, trigger: loras.find(lora => lora.name === person.name)?.trigger, gaze: previs.framed.gaze[person.name] }));
    const lensAsked = lensRow.test(span.row ?? "");
    const kept = shotSeconds(production, span.shot);
    const cut = kept < clip ? `\n\nThe film keeps only the first ${kept.toFixed(1)} seconds of this clip, the shot's length: everything the row asks for happens within them, and afterwards everyone carries on calmly, their eyes still where the shot ends them looking.` : "";
    const instructionsOf = (part: typeof span, duration: number, note: string) =>
      `${referenceVideoPromptInstructions(part, 1, { duration, dubbed, people, place: references.place?.place.look, blocking: previs.blocking }, ids)}${note}${correctionNote(video)}${lessonsOf(production)}\n\nOriginal script ({{ref 1}}):\n${script}\n\nShot list ({{ref 2}}):\n${shotList}`;
    // Has the text model write one prompt and fills in the lines of `dialogue`, rewritten once with the error. A person
    // the prompt never names by their trigger word is drawn without their LoRA, as anyone, and a line put in the mouth
    // of someone described otherwise is spoken by the wrong person.
    const write = async (instructions: string, dialogue?: string, scope = "", later = false) => {
      const finish = (draft: string) => {
        // A trigger word run into the next word ("siknsrman") is not the word the LoRA was trained on.
        const missing = loras.filter(lora => !new RegExp(`\\b${lora.trigger}\\s+(woman|man)\\b`, "i").test(draft) || new RegExp(`${lora.trigger}(?!\\s+(woman|man)\\b)`, "i").test(draft));
        if (missing.length) throw new Error(`Name ${missing.map(lora => `${lora.name} as "${lora.trigger} woman" or "${lora.trigger} man", with a space,`).join(" and ")} every time they are mentioned, and use that word for no one else`);
        // A name label means nothing to the video model, and someone out of frame named in it is drawn by guess.
        const labels = names.filter(name => new RegExp(`(?<!\\p{L})${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\p{L})`, "u").test(draft));
        if (labels.length) throw new Error(`Never write the name ${labels.join(" or ")}: refer to people in frame by their trigger word or look, and to someone out of frame as "someone off the left (or right) edge of the frame"`);
        const lens = lensLook.exec(draft);
        if (lens && !lensAsked) {
          throw new Error(/^lens/i.test(lens[0])
            ? `Remove every use of the word "lens", even about the camera or the shot size: the word alone draws the video model's eyes into it`
            : `"${lens[0]}" makes the person look into the lens: say where their eyes go instead, at a person or thing and the side of the frame it is on`);
        }
        // A trigger word before both "woman" and "man" gives one person's LoRA to two people.
        const shared = loras.filter(lora => new Set([...draft.matchAll(new RegExp(`\\b${lora.trigger}\\s+(woman|man)\\b`, "gi"))].map(match => match[1]!.toLowerCase())).size > 1);
        if (shared.length) throw new Error(`${shared.map(lora => `"${lora.trigger}" names ${lora.name} alone`).join(" and ")}: write it only for them, always followed by the same word, woman or man`);
        for (const { speaker } of parseDialogue(dialogue)) {
          const lora = loras.find(item => item.name === speaker);
          const at = draft.indexOf(`(${ids.get(speaker ?? "")}) says`);
          // ACT: The speaker's description is taken as the 200 characters before their ID; a longer one fails this check.
          if (lora && at >= 0 && !draft.slice(Math.max(0, at - 200), at).includes(lora.trigger)) {
            throw new Error(`The line of ${speaker} must be said by "${lora.trigger} woman" or "${lora.trigger} man", described right before (${ids.get(speaker!)}) says`);
          }
        }
        return fillDialogue(draft, parseDialogue(dialogue));
      };
      // A draft that breaks a rule is rewritten with the error, at most twice.
      const valid = async (draft: string, fixes = 2): Promise<string> => {
        try {
          finish(draft);
          return draft;
        } catch (error) {
          if (!fixes) throw error;
          return valid(await complete(`${instructions}\n\nYour prompt:\n${draft}\n\nFix this and output the whole prompt again: ${error instanceof Error ? error.message : String(error)}`), fixes - 1);
        }
      };
      // A draft still breaking a rule after its fixes is set aside for a fresh one with fixes of its own, so one stubborn
      // draft does not fail the production and stop its machines.
      let draft = await complete(instructions).then(text => valid(text)).catch(async () => valid(await complete(instructions)));
      // Before any GPU time the prompt is reviewed for the faults that made earlier clips fail, and rewritten with them.
      for (let round = 0; round < reviewRounds; round++) {
        // A review the model could not finish twice leaves the valid draft as it is, said in the log, not passed unread.
        const problems = await complete(promptReview(production, span.row ?? "", draft, scope, later)).then(readReview, (error: unknown) => {
          if (!(error instanceof ReplyCutError)) throw error;
          console.warn(`[production] Shot ${span.shot}: the prompt review failed and the draft is kept unreviewed:`, error);
          return [];
        });
        if (!problems.length) break;
        // A rewrite that still breaks a rule after its fix is dropped and the valid draft kept: the review only improves.
        const revised = await complete(`${instructions}\n\nYour prompt:\n${draft}\n\nA review found these faults; fix every one and output the whole prompt again:\n${problems.map(problem => `- ${problem}`).join("\n")}`)
          .then(text => valid(text)).catch(() => undefined);
        if (!revised) break;
        draft = revised;
      }
      return finish(draft);
    };
    const plan = longTakeParts(clip);
    if (plan.parts > 1) {
      // A long take: each part's prompt covers its own seconds of the shot and the lines that start in them, and
      // carries on from the part before without a cut.
      const lines = production.dub!.shots.find(item => item.shot === span.shot)!.lines;
      const dialogue = parseDialogue(span.dialogue);
      const seconds = (frames: number) => Number((frames / 24).toFixed(2));
      const beats = await takeBeats(span.row ?? "", clip, lines, previs.timeline, complete);
      // The parts are written side by side: each needs only its own seconds and beats, never another part's prompt.
      const written = await Promise.allSettled(Array.from({ length: plan.parts }, (_, part) => {
        const from = part * plan.step, to = from + plan.frames;
        // A part delivers its frames after the 22 it repeats; a line belongs to the part that delivers its start.
        const owns = (start: number) => start >= (part ? from + 22 : 0) && (part + 1 === plan.parts || start < (part + 1) * plan.step + 22);
        const own = dialogue.filter((_, index) => owns(Math.round((lines[index]?.start ?? 0) * 24)));
        const partSpan = { ...span, dialogue: own.map(line => line.speaker ? `${line.speaker}\uFF1A${line.words}` : line.words).join("\uFF1B") };
        const [start, end] = [seconds(from), seconds(Math.min(to, clip * 24))];
        const ownBeats = beats.filter(beat => beat.to > start && beat.from < end);
        // Where the last beat that ends before this part's first frame leaves everyone, which its opening must show
        // rather than the row's opening state; a beat still going then is one of this part's own.
        const opening = part ? beats.filter(beat => beat.to <= start).at(-1)?.after || undefined : undefined;
        const note = [
          `\n\nThis shot is one continuous take of ${clip} seconds without any cut, rendered in ${plan.parts} parts of ${seconds(plan.frames)} seconds. This prompt is part ${part + 1} of ${plan.parts}: seconds ${start}\u2013${end} of the shot.`,
          ...ownBeats.length ? [`Of the take's action, exactly these beats fall in this part, in this order, at these seconds of the take: ${ownBeats.map(beat => `${beat.from}\u2013${beat.to} s: ${beat.what}`).join("; ")}. Show them and nothing else of the row, which the other parts show; a beat that runs past this part's end is left mid-way, and one that began before it is already under way. Each line is spoken in the beat that holds its time.`] : [],
          "Where each person looks, as given above, is for the whole take: the start is the start of part 1 and the end the end of the last part; this part goes from where the part before leaves their eyes towards that end only as far as its seconds allow.",
          "Describe only what happens in those seconds, in time order; the other parts describe the rest. <Video 1> and <Audio 1> cover only this part.",
          ...part ? [`Its first 0.92 seconds repeat the end of part ${part} exactly: open on the same picture, positions and motion that part ends on, and carry on with the same camera.`] : [],
          ...opening ? [`Where everyone is as this part starts, after the beats before it: ${opening}`] : [],
          ...part ? ["Open the detailed description on that state; never on the row's opening state, and never on an action an earlier part already showed."] : [],
          ...part + 1 < plan.parts ? ["End with the take still going, mid-action, not on a pause or a resolved moment."] : [],
        ].join(" ");
        return write(instructionsOf(partSpan, seconds(plan.frames), note), partSpan.dialogue, note, part > 0);
      }));
      // Every part is awaited before an error is passed on, so none goes on writing unwatched.
      const failed = written.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      const parts = written.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      Object.assign(video, { parts, prompt: parts.join("\n\n") });
    } else {
      video.prompt = await write(instructionsOf(span, clip, cut), span.dialogue);
    }
    await save();
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}

/**
 * The beats of a long take's row in story order, each with the seconds of the take it spans and where everyone is when
 * it ends, spread over the whole take at a natural pace and around the lines' recorded times, so each part of the take
 * shows its own beats and none twice, and opens where the beats before it leave everyone. A reply that cannot be read
 * gives none, and each part falls back to its seconds alone.
 */
async function takeBeats(row: string, seconds: number, lines: ProductionDub["shots"][number]["lines"], timeline: string | undefined, complete: (prompt: string) => Promise<string>) {
  const reply = await complete([
    `A shot-list row is filmed as one continuous take of ${seconds} seconds without any cut. The row (shot size, camera, action, dialogue, cast, state):`,
    row,
    // The previs video the clip is rendered from moves people at these times, so the beats keep to them.
    ...timeline ? [`The take's previs moves the people at these seconds, and the beats follow the same moves at the same times: ${timeline}.`] : [],
    ...lines.length ? [`Its lines are recorded and fixed at these times of the take: ${lines.map(line => `${line.speaker} says "${line.words}" from ${(line.start ?? 0).toFixed(1)} to ${((line.start ?? 0) + (line.seconds ?? 0)).toFixed(1)} s`).join("; ")}.`] : [],
    "Split the row's action into beats in story order, each one visible action of the people, and give each the second it starts and ends, so the beats fill the whole take at a natural pace: nothing happens twice, a beat lasts at least two seconds, walking across a room takes three or more, opening or closing a door is a beat of its own in which someone's hand moves it, and each line falls in the beat that is going on at its time.",
    "Write each beat in English, naming people as the row does, and with it where everyone in the shot is when it ends: their posture, their place in the room and which way they face.",
    "Reply with JSON only: {\"beats\": [{\"from\": 0, \"to\": 3.5, \"what\": \"...\", \"after\": \"...\"}]}.",
  ].join("\n")).catch((error: unknown) => {
    // A reply cut off on every try gives no beats, as one that cannot be read does.
    if (error instanceof ReplyCutError) return "";
    throw error;
  });
  try {
    const value = replyJson(reply, "beats") as { beats?: unknown };
    const beats = (Array.isArray(value.beats) ? value.beats : []).flatMap(item => {
      const { from, to, what, after } = (item ?? {}) as Record<string, unknown>;
      return typeof from === "number" && typeof to === "number" && typeof what === "string" && 0 <= from && from < to && to <= seconds + 0.5 && what.trim()
        ? [{ from: Number(from.toFixed(1)), to: Number(Math.min(to, seconds).toFixed(1)), what: what.trim(), after: typeof after === "string" ? after.trim() : "" }] : [];
    });
    // Beats out of order or overlapping by more than a moment are not a timeline the parts can share.
    return beats.every((beat, index) => !index || beat.from >= beats[index - 1]!.to - 0.5) ? beats : [];
  } catch {
    return [];
  }
}

/**
 * Renders each clip not rendered yet into `folder`, with no first frame: the people its previs shows and the place as
 * reference images, its previs as the blocking reference, its dubbed track, those people's H3 LoRAs and its own seed. All are requested at once
 * and run one after another on one Colab machine. The first clip that fails cancels the ones still queued, so a broken
 * render does not keep the A100 busy with clips that fail the same way.
 */
export async function renderClips(cwd: string, production: Production, clips: ProductionClip[], resolution: "480p" | "720p" | "1080p", folder: string, signal: AbortSignal, save: () => Promise<void>) {
  const failed = new AbortController();
  const clipSignal = AbortSignal.any([signal, failed.signal]);
  try {
    const results = await Promise.allSettled(clips.filter(item => !item.video).map(async item => {
      const shot = production.shots!.find(other => other.shot === item.shot)!;
      const previs = production.previs!.find(other => other.shot === item.shot)!;
      const references = shotReferences(shot, production.assets!, previs.framed);
      const track = production.dub!.shots.find(shot => shot.shot === item.shot)?.track;
      const loras = references.people.flatMap(({ person }) => person.loras?.filter(lora => lora.family === "h3") ?? []).slice(0, maxLoras);
      const [video] = await generateMedia(cwd, "video", {
        ...h3, mode: "startFrameOptional", prompt: item.prompt!, duration: production.clips!.find(clip => clip.shot === item.shot)!.clip, resolution, ratio: production.input.ratio,
        generateAudio: true, outputDirectory: `${productionDirectory(production.id)}/${folder}`,
        images: referenceImages(references).map(path => ({ path, mimeType: mimeOf(path) })),
        // ACT: The previs goes in as a reference video rather than a control video, as the shot nodes do; skipPrevis only
        // lifts the server's control-video gate, which the previs reference satisfies.
        skipPrevis: true,
        videos: previs.video ? [{ path: previs.video, mimeType: "video/mp4" }] : [],
        audios: track ? [{ path: track, mimeType: "audio/wav" }] : [],
        loras: loras.map(lora => ({ path: lora.path, strength: 1 })), seed: item.seed, parts: item.parts,
      }, clipSignal).catch((error: unknown) => {
        failed.abort(error);
        throw error;
      });
      item.video = video!.path;
      item.seed = video!.seed;
      await save();
    }));
    // The first failure is the cause; the clips it cancelled only report the cancel.
    if (failed.signal.aborted) throw failed.signal.reason;
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) throw rejected.reason;
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

/**
 * How long a subtitle takes to read: about 9 characters a second for Chinese, Japanese or Korean and 17 for other
 * languages, and never under 5/6 s, as broadcasters' subtitle guides set.
 */
function readingSeconds(words: string) {
  const characters = [...words.replace(/\s+/g, " ").trim()].length;
  return Math.max(5 / 6, characters / (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(words) ? 9 : 17));
}

/** One SRT time stamp, such as 00:01:02,345. */
function srtTime(seconds: number) {
  const milliseconds = Math.round(seconds * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(milliseconds / 3_600_000))}:${pad(Math.floor(milliseconds / 60_000) % 60)}:${pad(Math.floor(milliseconds / 1000) % 60)},${pad(milliseconds % 1000, 3)}`;
}

/**
 * Finishes the film from the final clips, or the rough cut's at 480p: joins them in shot order, each cut to its shot's
 * length, with each clip's sound at one loudness, lays the music and each place's ambience bed under the dialogue,
 * ducks the music while people speak as the soundtrack mix node does, and burns in each dubbed line as a subtitle while it
 * is spoken and long enough to read. A bed runs on from shot to shot of its place, so a cut inside a scene does not
 * restart it.
 */
export async function finishFilm(cwd: string, production: Production, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const duration = (path: string) => new Promise<number>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(Number(data.format.duration) || 0)));
  const clips = [...production.videos!].sort((a, b) => a.shot - b.shot);
  const lengths = await Promise.all(clips.map(async clip => Math.min(await duration(clip.video!), shotSeconds(production, clip.shot))));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const folder = productionDirectory(production.id);
  let subtitles: string | undefined;
  if (production.input.subtitles) {
    let offset = 0;
    const entries = clips.flatMap((clip, index) => {
      const start = offset;
      offset += lengths[index]!;
      return (production.dub!.shots.find(shot => shot.shot === clip.shot)?.lines ?? []).flatMap(line => line.start === undefined || !line.seconds || line.start >= lengths[index]! ? []
        : [{ from: start + line.start, to: start + line.start + line.seconds, words: line.words }]);
    });
    // A subtitle stays up at least as long as it takes to read, until the next one or the end of the film.
    entries.forEach((entry, index) => entry.to = Math.min(Math.max(entry.to, entry.from + readingSeconds(entry.words)), entries[index + 1]?.from ?? total, total));
    if (entries.length) {
      subtitles = `${folder}/subtitles.srt`;
      const text = entries.map((entry, index) => `${index + 1}\n${srtTime(entry.from)} --> ${srtTime(entry.to)}\n${entry.words}\n`).join("\n");
      await writeProductionText(cwd, subtitles, text);
    }
  }
  // Each bed is one looped input, split into the stretches its place's shots take in order; a shot of a place with no
  // bed lays silence there.
  const beds = [...new Map((production.ambience ?? []).flatMap(item => item.bed ? [[item.place, item.bed.path] as const] : [])).entries()];
  const bedInput = (place: string) => beds.findIndex(([name]) => name === place);
  const firstBed = clips.length + (production.music ? 1 : 0);
  const played = new Map<string, number>();
  const stretches = clips.map((clip, index) => {
    const place = production.shots!.find(shot => shot.shot === clip.shot)?.place ?? "";
    const start = played.get(place) ?? 0;
    played.set(place, start + lengths[index]!);
    return { input: bedInput(place), start, length: lengths[index]! };
  });
  const ambience = beds.length ? [
    ...beds.map((_, input) => {
      const uses = stretches.filter(stretch => stretch.input === input).length;
      return `[${firstBed + input}:a]asplit=${uses}${Array.from({ length: uses }, (_, use) => `[bed${input}u${use}]`).join("")}`;
    }).filter((_, input) => stretches.some(stretch => stretch.input === input)),
    ...stretches.map((stretch, index) => {
      const use = stretches.slice(0, index).filter(other => other.input === stretch.input).length;
      return stretch.input < 0
        ? `anullsrc=r=48000:cl=stereo,atrim=duration=${stretch.length}[ambience${index}]`
        // Fades only where the place changes, so a cut inside a scene leaves no dip in its bed.
        : `[bed${stretch.input}u${use}]atrim=start=${stretch.start}:duration=${stretch.length},asetpts=PTS-STARTPTS${stretches[index - 1]?.input === stretch.input ? "" : ",afade=t=in:d=0.05"}${stretches[index + 1]?.input === stretch.input ? "" : `,afade=t=out:st=${Math.max(0, stretch.length - 0.05)}:d=0.05`}[ambience${index}]`;
    }),
    `${stretches.map((_, index) => `[ambience${index}]`).join("")}concat=n=${stretches.length}:v=0:a=1[ambience]`,
  ] : [];
  // Only the music ducks under the lines: a room tone that dips while people speak and swells back after each line
  // sounds pumped, while a real room keeps its sound under them.
  const layers = ["[voice]", ...production.music ? ["[ducked]"] : [], ...beds.length ? ["[ambience]"] : []];
  const filters = [
    ...clips.map((clip, index) => {
      const spoken = !!production.dub!.shots.find(shot => shot.shot === clip.shot)?.lines.length;
      return `[${index}:a]${spoken ? `${dialogueLoudness},` : ""}aresample=48000,aformat=channel_layouts=stereo[a${index}]`;
    }),
    `${clips.map((_, index) => `[${index}:v][a${index}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][dialogue]`,
    // The subtitle file sits in the production folder, a path of plain characters relative to the workspace FFmpeg runs in.
    subtitles ? `[v]subtitles=filename=${subtitles}:force_style='FontSize=24,Outline=2,Shadow=1,MarginV=24'[picture]` : "[v]null[picture]",
    ...production.music ? [`[${clips.length}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total},asetpts=PTS-STARTPTS,volume=${musicVolume},afade=t=in:d=2,afade=t=out:st=${Math.max(0, total - 3)}:d=3[music]`] : [],
    ...ambience,
    production.music ? "[dialogue]asplit=2[voice][key];[music][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked]" : "[dialogue]anull[voice]",
    `${layers.join("")}${layers.length > 1 ? `amix=inputs=${layers.length}:normalize=0:duration=first,` : ""}alimiter=limit=0.95[sound]`,
  ];
  const output = `${folder}/film.mp4`;
  const command = cutClips(ffmpeg(), production, clips);
  // The score repeats if it is shorter than the film; atrim cuts it to the film's length.
  if (production.music) command.input(production.music).inputOptions("-stream_loop", "-1");
  // A bed shorter than its scene loops.
  for (const [, path] of beds) command.input(path).inputOptions("-stream_loop", "-1");
  command.complexFilter(filters, ["picture", "sound"])
    .outputOptions(["-c:v libx264", "-crf 18", "-pix_fmt yuv420p", "-c:a aac", "-b:a 192k", "-movflags +faststart"]).output(output);
  await finished(command);
  return output;
}

// Frames a clip check reads, as shares of the part of the clip the film keeps.
// Six frames across the part of the clip the film keeps, so an action is seen from start to end.
const checkTimes = [0.05, 0.25, 0.45, 0.65, 0.85, 0.98];

/**
 * The references a clip is checked against (its previs layout, then the people's and the place's images) and frames of
 * the part of the clip the film keeps, as base64 PNGs, the frames saved beside the clips for a person to see.
 */
export async function clipFrames(cwd: string, production: Production, clip: ProductionClip, references: string[], signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const probed = await new Promise<number>((resolve, reject) => ffmpeg.ffprobe(clip.video!, (error, data) => error ? reject(error) : resolve(Number(data.format.duration) || 0)));
  const length = Math.min(probed, shotSeconds(production, clip.shot));
  const folder = await checksFolder(cwd, production);
  const frames = references.map((_, index) => `${folder}/shot${clip.shot}Reference${index + 1}.png`);
  // Each render of a shot keeps its own frames, so the one kept after its corrections can still be looked at.
  const take = (clip.attempts?.length ?? 0) + 1;
  await Promise.all(references.map((image, index) => finished(ffmpeg(image).frames(1).outputOptions(["-vf scale=640:-2"]).output(frames[index]!))));
  for (const [index, share] of checkTimes.entries()) {
    const frame = `${folder}/shot${clip.shot}Take${take}Frame${index + 1}.png`;
    await finished(ffmpeg(clip.video!).seekInput(length * share).frames(1).outputOptions(["-vf scale=640:-2"]).output(frame));
    frames.push(frame);
  }
  return Promise.all(frames.map(async path => Buffer.from(await readFile((await resolveWorkspacePath(cwd, path)).path)).toString("base64")));
}

// Everything a check reads is scaled to 640 px wide, which keeps the model's image reading short.
async function checksFolder(cwd: string, production: Production) {
  const folder = `${productionDirectory(production.id)}/checks`;
  await mkdir((await resolveWorkspacePath(cwd, folder, true)).path, { recursive: true });
  return folder;
}

/**
 * Asks for every problem in a clip, each marked major or minor, as JSON. ACT: The model names problems well but scored
 * clips 85/92 whatever it found, a changed set and clothes included, so the verdict follows the problems it marks major.
 * Looks are judged against the reference images only: given a written description of the picture as well, the model
 * took the words for the picture and failed every clip of the first production, natural movement included. The action and
 * the gaze are judged against the shot-list row: judging looks alone, the check passed a jacket put on instead of taken
 * off and five people staring into the lens, while most "melted faces" it failed were one motion-blurred frame. Judging
 * the row word by word, it then failed all six clips of a film twice over a look's side of the frame or an action still
 * under way, while missing what viewers saw, so a problem is major only when a viewer would notice it.
 */
export function clipCheckPrompt(prompt: string, row: string, gazes: string, looks: number) {
  return [
    `The first image is the shot's grey-box previs layout, which fixes the camera, framing and where each person stands; the next ${looks} show how the people and the place must look; the last six are frames from the video clip at ${checkTimes.map(time => `${Math.round(time * 100)}%`).join(", ")} of the part the film keeps.`,
    `The shot-list row (shot size, camera, action, dialogue, cast, state): ${row}`,
    ...gazes ? [`Where each person should look: ${gazes}.`] : [],
    `The clip was asked for: ${prompt}`,
    "Judge what happens across the frames against the row: the action must happen as the row says, in the right direction (taking a jacket off is not putting it on, coming in is not standing inside), and no one looks into the camera lens unless the row asks for it.",
    "Compare the camera, the framing and which side of the frame each person is on with the previs layout, and the looks with the reference images, never with the words: where the words describe the picture differently, the images are right. Postures and actions come from the row: where the previs shows someone standing or seated differently from the row, the row is right.",
    "List every problem you see, then judge each as a viewer of the finished film would, watching it once at normal speed: a problem is major only when a viewer would notice it or misread the story. It is major when the row's action does not happen, so the viewer cannot tell what happens, or happens the wrong way; someone looks at another person or thing than the row says, or into the lens though the row does not ask for it; someone's face, hair or clothes, or the place, differ from the reference images; someone the row's cast names is missing, or another person stands in for them; the shot is clearly wider or tighter than the row's shot size, or the people stand on the other sides of the frame from the previs layout; someone shows up who is not in the references; someone appears from nowhere, vanishes or jumps to another place; a door, sliding door or window opens or closes by itself, with no one at it, behind it or reaching for it; a face, hand or body is deformed in two or more frames in a row; or someone passes through furniture or another person. One soft or smeared frame during a fast movement is motion blur, not a problem. Anything a viewer would not notice is minor: a look at the right person that leans a little to another side of the frame, an action still under way as the clip ends, a small drift of the framing or of the camera from the previs.",
    "Reply with JSON only: {\"issues\": [{\"problem\": \"what you saw, with the frame\", \"major\": true or false}]}, with an empty list when there is nothing wrong.",
  ].join("\n");
}

/** Reads the check's JSON: a clip passes without major problems; a reply that cannot be read fails rather than trusted. */
export function readClipCheck(reply: string): ClipCheck {
  const unreadable = { issues: [{ problem: "The check's reply could not be read.", major: true }], passed: false, unreadable: true };
  try {
    const value = replyJson(reply, "issues") as { issues?: unknown };
    // A list holding anything but problems, such as bare sentences, is not read as no problems.
    if (!Array.isArray(value.issues) || value.issues.some(item => !item || typeof item !== "object" || typeof (item as { problem?: unknown }).problem !== "string")) return unreadable;
    const issues = (value.issues as { problem: string; major?: unknown }[]).map(item => ({ problem: item.problem, major: item.major === true })).slice(0, 10);
    return { issues, passed: !issues.some(item => item.major) };
  } catch {
    return unreadable;
  }
}

