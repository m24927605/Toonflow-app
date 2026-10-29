import { z } from "zod";
import { createHash } from "node:crypto";
import type { FfmpegCommand, FfprobeData } from "@toonflow/ffmpeg";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { finishPrompt, shotDialogue, validateVideoPrompt, videoPromptInstructions } from "@toonflow/node-shared/videoPrompt";
import { findOnScreenText } from "@toonflow/tools-scaffold/onScreenText";
import { mkdir, readdir, readFile, rename, rm, stat, writeAtomic } from "@toonflow/file";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { snapshotMedia, inputSnapshotSchema } from "@/utils/media/snapshot";
import { longTakeParts, takeClipArtifact, withClipPostprocess, clipArtifactSchema, type ClipArtifact } from "@/utils/media/sulphur";
import { maxWanRemixSeconds } from "@/utils/media/wanRemix";
import { colabSessionName, useExistingColabSession } from "@/utils/media/colabPool";
import postprocess from "./postprocessColab.py" with { type: "text" };
import { ReplyCutError, replyJson } from "./review";
import type { VisualCheck } from "./checks";
import { maxLoras, opensUpright, shotReferences } from "./shots";
import { clipSeconds, type ProductionDub } from "./dub";
import { productionDirectory, writeProductionText, type Production } from "./state";
import { describeGaze } from "./plan";
import { explicitShot } from "./keyframes";

/**
 * A shot's clip. `check` is the vision model's verdict on its frames; `feedback` the major problems of the render before,
 * which the prompt is rewritten to avoid; `attempts` keeps every earlier render that failed, so the best is kept.
 */
export type ProductionClip = {
  shot: number; prompt?: string; parts?: string[]; video?: string; seed?: number; remote?: ClipArtifact; inputSnapshot?: z.infer<typeof inputSnapshotSchema>;
  check?: VisualCheck; feedback?: string[]; attempts?: Omit<ProductionClip, "attempts">[];
};

const sulphur = { providerId: "sulphur", modelId: "sulphur_2" };
// Explicit shots render on Wan 2.2 Remix V3 from their LUSTIFY start frame, without LoRAs (the user's choice over TenStrip
// V5 on 2026-10-28); a Remix clip lasts at most fifteen seconds, chained past five with SVI 2.0 Pro.
const remix = { providerId: "wanRemix", modelId: "wan22_remix_v3" };
/**
 * How long a shot plays in the film: its time in the shot list, or longer when its lines need it. Sulphur 2 renders
 * whole seconds, so the film cuts each clip to this.
 */
const shotSeconds = (production: Production, shot: number) => production.dub!.shots.find(item => item.shot === shot)!.seconds;
const mimeOf = (path: string) => /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.mp4$/i.test(path) ? "video/mp4" : /\.wav$/i.test(path) ? "audio/wav" : "image/png";
/**
 * Whether a shot's clip follows its previs depth video: one where someone walks or the camera moves. Otherwise the
 * previs has no movement to give, and its columns would only fight the poses the clip's prompt describes. Its people
 * are upright columns, so a shot where anyone lies, sits or kneels, or changes clothes (the column hides the arms and
 * garments that move), never follows it: the clip draws them as pillars. An explicit shot renders on Wan Remix, which
 * takes no control video.
 */
const controlled = (production: Production, shot: number) => {
  const previs = production.previs!.find(item => item.shot === shot)!;
  const shots = production.plan?.shots ?? [];
  const actors = shots.find(item => item.shot === shot)?.actors ?? [];
  // The contract gives each shot's opening outfit, so an outfit that differs at the actor's next shot changes in this one.
  const changesClothes = actors.some(actor => {
    const next = shots.find(item => item.shot > shot && item.actors.some(other => other.name === actor.name));
    return next && next.actors.find(other => other.name === actor.name)!.outfit !== actor.outfit;
  });
  return !explicitShot(production, shot) && opensUpright(production, shot) && !changesClothes && (!!previs.framed.walkers?.length || (previs.framed.camera?.frames.length ?? 1) > 1);
};

// How near the camera has to stay, in metres, and how equal its lens, for a shot to keep the setup of the one before.
const sameSetup = 0.15;

/**
 * The shot whose last frame this one starts from: the one before, when this shot keeps its camera setup (the camera
 * starts where the previous one ended, with the same lens and the same people in frame) and that shot did not itself
 * start from another clip. Each clip taken from a frame of another adds that clip's drift, so a third clip of one setup
 * starts from its own keyframe again.
 */
export function continuedFrom(production: Production, shot: number): number | undefined {
  const index = production.previs!.findIndex(item => item.shot === shot);
  const previous = production.previs![index - 1];
  const current = production.previs![index];
  const ended = previous?.framed.camera?.frames.at(-1);
  const starts = current?.framed.camera?.frames[0];
  if (!previous || !ended || !starts || continuedFrom(production, previous.shot) !== undefined) return undefined;
  const distance = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const sameCast = [...previous.framed.shown].sort().join("|") === [...current.framed.opening].sort().join("|");
  return sameCast && distance(ended.position, starts.position) < sameSetup && distance(ended.target, starts.target) < sameSetup && Math.abs(ended.fov - starts.fov) < 1 ? previous.shot : undefined;
}

/** The people of a shot as its prompt names them: by name and LoRA trigger word, with their look and opening state. */
function promptPeople(production: Production, shot: number) {
  const row = production.shots!.find(item => item.shot === shot)!;
  const previs = production.previs!.find(item => item.shot === shot)!;
  const contract = production.plan!.shots.find(item => item.shot === shot)!;
  return shotReferences(row, production.assets!, previs.framed).people.slice(0, 8).map(({ person }) => {
    const outfit = person.outfits?.find(item => item.name === row.outfits[person.name]);
    const actor = contract.actors.find(item => item.name === person.name);
    // An explicit shot's clip takes no LoRA, so its prompt names no trigger word.
    const trigger = explicitShot(production, shot) ? undefined : person.triggers?.ltx ?? person.loras?.find(lora => lora.family === "ltx")?.trigger;
    return {
      name: person.name, trigger, look: `${person.look}${outfit ? ` Wearing ${outfit.look}` : ""}`,
      opening: previs.framed.opening.includes(person.name) ? `${actor ? `${actor.pose} ${describeGaze(actor.gaze)}.` : "In the frame."}` : "Not in the first frame; enters during the shot.",
    };
  });
}

/** Checks a shot's saved prompts, one or a long take's parts, still fit it: each valid and naming every LoRA trigger, and together speaking every line in order. */
function promptFits(prompts: string[], production: Production, shot: number, lines: { words: string }[]) {
  try { prompts.forEach(validateVideoPrompt); } catch { return false; }
  const triggers = promptPeople(production, shot).flatMap(person => person.trigger ? [person.trigger] : []);
  const spoken = prompts.flatMap(prompt => [...prompt.matchAll(/"([^"]*)"/g)].map(match => match[1]));
  return prompts.every(prompt => triggers.every(trigger => prompt.includes(trigger))) && spoken.join("\n") === lines.map(line => line.words).join("\n");
}

/**
 * Writes the Sulphur 2 prompt of every shot without a fitting one with the text model, saving each: the shared
 * instructions, here with the script and shot list inline, what the shot's first frame shows, its people by name and
 * LoRA trigger word, the previs blocking its depth video moves, and the lines as markers that finishPrompt replaces
 * with the original words. Invalid drafts are rewritten with the error, five times at most. `only` limits writing to
 * those shots while the other shots proceed independently.
 */
export async function writeClipPrompts(production: Production, script: string, shotList: string, complete: (prompt: string) => Promise<string>, save: () => Promise<void>, only?: number[]) {
  const allSpans = shotSpans(checkScript(shotList).shots, shotList);
  const spans = allSpans.filter(span => !only || only.includes(span.shot));
  const videos = production.videos ??= allSpans.map((span): ProductionClip => ({ shot: span.shot }));
  // Shots are written side by side, as the text model answers two requests at once, and so are a long take's parts.
  // Every shot is awaited before an error is passed on, so none goes on writing unwatched.
  const results = await Promise.allSettled(spans.map(async span => {
    const video = videos.find(item => item.shot === span.shot)!;
    if (video.video) return;
    const dub = production.dub!.shots.find(item => item.shot === span.shot)!;
    const clip = clipSeconds(dub.seconds);
    const lines = shotDialogue(span);
    const saved = video.parts ?? (video.prompt ? [video.prompt] : []);
    if (saved.length && promptFits(saved, production, span.shot, lines)) return;
    delete video.prompt;
    delete video.parts;
    const previs = production.previs!.find(item => item.shot === span.shot)!;
    const shot = production.shots!.find(item => item.shot === span.shot)!;
    const place = production.assets!.places.find(item => item.name === shot.place);
    const placeLook = place?.look;
    // A keyframe shows how everyone looks, so the prompt names people and leaves their looks to the picture.
    const people = promptPeople(production, span.shot).map(person => shot.keyframe ? { ...person, look: undefined } : person);
    const names = new Map(people.map(person => [person.name, [person.name, ...person.trigger ? [person.trigger] : []]]));
    const control = controlled(production, span.shot);
    const opening = shot.keyframe ? `The clip starts from a pinned picture, its keyframe, which shows: ${shot.keyframe.description}` : `${people.filter(person => previs.framed.opening.includes(person.name)).map(person => `${person.name}: ${person.opening}`).join(" ") || "Nobody is in the frame."}${placeLook ? ` The place: ${placeLook}` : ""}`;
    const kept = shotSeconds(production, span.shot);
    const fixes = video.feedback?.length ? `An earlier render of this shot failed its check with: ${video.feedback.join("; ")}. Write the prompt so that none of this happens again.` : undefined;
    const cut = [kept < clip ? `The film keeps only the first ${kept.toFixed(1)} seconds of this clip, the shot's length: everything the row asks for happens within them, and afterwards everyone carries on calmly, their eyes still where the shot ends them looking.` : undefined, fixes].filter(Boolean).join(" ") || undefined;
    const instructionsOf = (part: typeof span, duration: number, note?: string) => `${videoPromptInstructions(part, 1, { duration, style: "photorealistic live-action", opening, people, place: shot.keyframe ? undefined : placeLook, control, blocking: previs.blocking, note })}\n\nAuthoritative production contract: ${JSON.stringify(production.plan?.shots.find(item => item.shot === span.shot))}\n\nOriginal script ({{ref 1}}):\n${script}\n\nShot list ({{ref 2}}):\n${shotList}`;
    // Has the text model write the prompt and fills in the lines of `partLines`; a draft that breaks a rule is rewritten
    // with the error, at most five times.
    const write = async (instructions: string, partLines = lines) => {
      const finish = (draft: string) => {
        // A clip without a keyframe has nothing else that keeps the place: the same sentence in every shot keeps it the
        // same room, so it follows the opening sentence when the draft does not hold it already.
        const finished = finishPrompt(draft, partLines, names);
        const placeSentence = !shot.keyframe && placeLook && `${placeLook.replace(/\.$/, "")}.`;
        const prompt = !placeSentence || finished.includes(placeSentence) ? finished : finished.replace(/^(.*?[.!?])\s/, `$1 ${placeSentence} `);
        validateVideoPrompt(prompt);
        const text = findOnScreenText(prompt);
        if (text.length) throw new Error(`Ask for no on-screen text (${text.join(", ")}): captions, signs and titles are added after the clip is made`);
        for (const person of people) if (person.trigger && !prompt.includes(person.trigger)) throw new Error(`Write ${person.name}'s trained identity trigger word ${person.trigger} right after their name`);
        return prompt;
      };
      const valid = async (draft: string, fixes = 5): Promise<string> => {
        try {
          return finish(draft);
        } catch (error) {
          // The last draft is kept in the server log, so a shot whose prompt cannot be written can be diagnosed.
          if (!fixes) console.error("[production] Clip prompt still breaks a rule after its fixes", { shot: span.shot, error: error instanceof Error ? error.message : String(error), draft });
          if (!fixes) throw error;
          return valid(await complete(`${instructions}\n\nYour draft:\n${draft}\n\nFix this and output the whole prompt again: ${error instanceof Error ? error.message : String(error)}`), fixes - 1);
        }
      };
      return valid(await complete(instructions));
    };
    if (explicitShot(production, span.shot)) {
      if (clip > maxWanRemixSeconds) throw new Error(`Shot ${span.shot} is explicit and lasts ${clip} seconds; Wan Remix renders at most ${maxWanRemixSeconds} seconds, so split it into shorter shots`);
      // Remix renders no sound and does not move lips to words, so a line in an explicit shot would be heard without anyone saying it.
      if (lines.length) throw new Error(`Shot ${span.shot} is explicit and has dialogue; Wan Remix does not lip-sync, so move its lines to a shot without sex`);
      video.prompt = await writeExplicitPrompt(span.row ?? "", shot.keyframe?.description, fixes, complete);
      await save();
      return;
    }
    const plan = longTakeParts(clip);
    if (plan.parts > 1) {
      // A long take: each part's prompt covers its own seconds of the shot and the lines that start in them, and
      // carries on from the part before without a cut.
      const seconds = (frames: number) => Number((frames / 24).toFixed(2));
      const context = plan.frames - plan.step;
      const beats = await takeBeats(span.row ?? "", clip, dub.lines, previs.timeline, complete);
      // The parts are written side by side: each needs only its own seconds and beats, never another part's prompt.
      const written = await Promise.allSettled(Array.from({ length: plan.parts }, (_, part) => {
        const from = part * plan.step, to = from + plan.frames;
        // A part delivers its frames after the ones it repeats; a line belongs to the part that delivers its start.
        const owns = (start: number) => start >= (part ? from + context : 0) && (part + 1 === plan.parts || start < (part + 1) * plan.step + context);
        const own = lines.filter((_, index) => owns(Math.round((dub.lines[index]?.start ?? 0) * 24)));
        const partSpan = { ...span, dialogue: own.map(line => line.speaker ? `${line.speaker}\uFF1A${line.words}` : line.words).join("\uFF1B") };
        const [start, end] = [seconds(from), seconds(Math.min(to, clip * 24))];
        const ownBeats = beats.filter(beat => beat.to > start && beat.from < end);
        // Where the last beat that ends before this part's first frame leaves everyone, which its opening must show
        // rather than the row's opening state; a beat still going then is one of this part's own.
        const opening = part ? beats.filter(beat => beat.to <= start).at(-1)?.after || undefined : undefined;
        const note = [
          `This shot is one continuous take of ${clip} seconds without any cut, rendered in ${plan.parts} parts of ${seconds(plan.frames)} seconds. This prompt is part ${part + 1} of ${plan.parts}: seconds ${start}\u2013${end} of the shot.`,
          ...ownBeats.length ? [`Of the take's action, exactly these beats fall in this part, in this order, at these seconds of the take: ${ownBeats.map(beat => `${beat.from}\u2013${beat.to} s: ${beat.what}`).join("; ")}. Show them and nothing else of the row, which the other parts show; a beat that runs past this part's end is left mid-way, and one that began before it is already under way. Each line is spoken in the beat that holds its time.`] : [],
          "Where each person looks, as given above, is for the whole take: the start is the start of part 1 and the end the end of the last part; this part goes from where the part before leaves their eyes towards that end only as far as its seconds allow.",
          "Describe only what happens in those seconds, in time order; the other parts describe the rest. The control video and the soundtrack cover only this part.",
          ...part ? [`Its first ${seconds(context)} seconds repeat the end of part ${part} exactly: open on the same picture, positions and motion that part ends on, and carry on with the same camera.`] : [],
          ...opening ? [`Where everyone is as this part starts, after the beats before it: ${opening}`] : [],
          ...part ? ["Open on that state; never on the row's opening state, and never on an action an earlier part already showed. The first frame described above is the start of part 1 only."] : [],
          ...part + 1 < plan.parts ? ["End with the take still going, mid-action, not on a pause or a resolved moment."] : [],
          ...fixes ? [fixes] : [],
        ].join(" ");
        return write(instructionsOf(partSpan, seconds(plan.frames), note), own);
      }));
      // Every part is awaited before an error is passed on, so none goes on writing unwatched.
      const failed = written.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      video.parts = written.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      video.prompt = video.parts.join("\n\n");
    } else {
      video.prompt = await write(instructionsOf(span, clip, cut));
    }
    await save();
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}

/**
 * Writes the Wan Remix prompt of an explicit shot strictly to the formula its prompts are written in (the user's
 * highest constraint, 2026-10-27): one line of short comma-joined phrases, subject and action, then camera, then
 * lighting, then style, the act in blunt colloquial words. In 〈雨夜〉 that wording alone decided the clip: "fast sloppy
 * blowjob" moved the head twice as far as "sucks hard and fast", "slow, deep thrusts" never reached the root while
 * "balls-deep, hips slapping flush" did, and "moans loudly with her mouth open" drew a screaming mouth. A draft that
 * breaks the form is rewritten with the error, five times at most.
 */
async function writeExplicitPrompt(row: string, opening: string | undefined, fixes: string | undefined, complete: (prompt: string) => Promise<string>) {
  const instructions = [
    "Write the prompt of an explicit adult image-to-video clip for Wan 2.2 Remix, an uncensored video model, from the shot-list row below and the first frame the clip starts from.",
    `The shot-list row (shot size, camera, action, cast, state): ${row}`,
    ...opening ? [`The first frame shows: ${opening}`] : [],
    "Follow this formula exactly: one line of short phrases joined by commas, 50 to 100 words, in this order:",
    "1. Subject and action: who is where as in the first frame, called the man and the woman (never by name), and the sex act in the bluntest, crudest everyday porn words, short, simple, rough and direct (fucks her pussy hard and fast, fast sloppy blowjob, pounding his cock balls-deep into her on every thrust, his hips slapping flush against hers, bobbing her head all the way down his cock and back to the tip, jerking his cock fast up and down the whole shaft). Every movement goes fast and to its full range. Then each hand exactly where the first frame has it, where they look, and their sounds in a few words; a moan is written with her lips slightly parted, never with her mouth open or loud, which draws a screaming mouth.",
    "2. Camera: static, the shot size and the camera height from the row, for example static medium shot at bed level.",
    "3. Lighting: the light source and its colour as the first frame shows it, and one detail of the place, for example warm bedside lamp light, rain on the window.",
    "4. Style: end with exactly: photorealistic",
    "No full sentences, names, dialogue, quotation marks, timestamps, line breaks, Markdown or anything else. Output only the prompt.",
    ...fixes ? [fixes] : [],
  ].join("\n");
  const check = (draft: string) => {
    const prompt = draft.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
    validateVideoPrompt(prompt);
    const words = prompt.split(" ").length;
    if (words < 40 || words > 130) throw new Error(`The prompt has ${words} words; write 50 to 100`);
    if (/["“”]/.test(prompt)) throw new Error("Write no quotation marks or dialogue");
    if (!prompt.endsWith("photorealistic")) throw new Error('End with exactly "photorealistic"');
    if (/mouth (wide )?open|open[- ]mouthed|moans? loudly/i.test(prompt)) throw new Error("Write her moaning with her lips slightly parted, never with her mouth open or loud");
    return prompt;
  };
  const valid = async (draft: string, left = 5): Promise<string> => {
    try {
      return check(draft);
    } catch (error) {
      if (!left) throw error;
      return valid(await complete(`${instructions}\n\nYour draft:\n${draft}\n\nFix this and output the whole prompt again: ${error instanceof Error ? error.message : String(error)}`), left - 1);
    }
  };
  return valid(await complete(instructions));
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
 * Takes the last clear frame of the clip a shot continues as its start frame: of the frames in the last quarter second
 * the film keeps of that clip (it cuts each clip to its shot's length), the one with the most detail.
 * ACT: Detail is measured as the PNG's size, which falls with motion blur; a sharpness measure such as the variance of
 * a Laplacian on the faces would be more exact, at the cost of decoding every candidate.
 */
export async function takeStartFrame(cwd: string, production: Production, shot: number, signal: AbortSignal, save: () => Promise<void>) {
  const row = production.shots!.find(item => item.shot === shot)!;
  const previous = continuedFrom(production, shot);
  if (row.startFrame || previous === undefined) return;
  const clip = production.videos!.find(item => item.shot === previous)!;
  if (!clip.video) throw new Error(`Shot ${shot}: the clip it continues is not rendered yet`);
  const folder = `${productionDirectory(production.id)}/startFrames`;
  const candidates = `${folder}/shot${shot}Candidates`;
  const directory = (await resolveWorkspacePath(cwd, candidates, true)).path;
  await mkdir(directory, { recursive: true });
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const end = shotSeconds(production, previous);
  await finished(ffmpeg((await resolveWorkspacePath(cwd, clip.video)).path).seekInput(Math.max(0, end - 0.25)).duration(0.25).outputOptions(["-fps_mode passthrough"]).output(`${directory}/frame%02d.png`));
  const frames = (await readdir(directory)).filter(name => name.endsWith(".png"));
  if (!frames.length) throw new Error(`Shot ${shot}: no frame could be taken from the end of shot ${previous}`);
  const sizes = await Promise.all(frames.map(async name => ({ name, size: (await stat(`${directory}/${name}`)).size })));
  const best = sizes.sort((a, b) => b.size - a.size)[0]!.name;
  const target = `${folder}/shot${shot}.png`;
  await rename(`${directory}/${best}`, (await resolveWorkspacePath(cwd, target, true)).path);
  await rm(directory, { recursive: true, force: true });
  row.startFrame = target;
  await save();
}

/**
 * Renders each clip not rendered yet into `folder`: from no picture, or from the previous clip's last frame when it
 * continues that clip's setup, following its previs depth video when someone walks or the camera moves, locked to its
 * dubbed track, with the LoRAs of its people and its own seed. All are
 * requested at once and share the Sulphur 2 worker pool. The first clip that fails cancels the ones still queued, so a
 * broken render does not keep the A100 busy with clips that fail the same way.
 */
export async function renderClips(cwd: string, production: Production, clips: ProductionClip[], resolution: "480p" | "720p" | "1080p", folder: string, signal: AbortSignal, save: () => Promise<void>) {
  const failed = new AbortController();
  const clipSignal = AbortSignal.any([signal, failed.signal]);
  const results = await Promise.allSettled(clips.filter(item => !item.video).map(async item => {
    const shot = production.shots!.find(other => other.shot === item.shot)!;
    const previs = production.previs!.find(other => other.shot === item.shot)!;
    const references = shotReferences(shot, production.assets!, previs.framed);
    const track = production.dub!.shots.find(shot => shot.shot === item.shot)?.track;
    const loras = references.people.map(({ person }) => person).flatMap(item => item.loras?.filter(lora => lora.family === "ltx") ?? []).slice(0, maxLoras);
    const snapshot = await prepareClipInputs(cwd, production, item, clipSignal, save);
    const frozenInput = (path: string) => {
      const frozen = snapshot.files.find(item => item.source === path)?.path;
      if (!frozen) throw new Error(`Missing frozen clip input: ${path}`);
      return frozen;
    };
    const explicit = explicitShot(production, item.shot);
    const control = controlled(production, item.shot);
    const generate = () => explicit ? generateMedia(cwd, "video", {
      ...remix, mode: "singleImage", prompt: item.prompt!, duration: production.clips!.find(clip => clip.shot === item.shot)!.clip, resolution: "720p", ratio: production.input.ratio,
      outputDirectory: `${productionDirectory(production.id)}/${folder}`, firstFrame: { path: frozenInput(shot.startFrame!), mimeType: mimeOf(shot.startFrame!) }, skipPrevis: true, seed: item.seed,
    }, clipSignal).then(async ([video]) => [{ ...video!, path: await conformClip(cwd, video!.path, resolution, production.input.ratio, clipSignal) }]) : generateMedia(cwd, "video", {
      ...sulphur, mode: control ? "videoControl" : shot.startFrame ? "startFrameOptional" : "text", prompt: item.prompt!, duration: production.clips!.find(clip => clip.shot === item.shot)!.clip, resolution, ratio: production.input.ratio,
      generateAudio: true, outputDirectory: `${productionDirectory(production.id)}/${folder}`,
      ...shot.startFrame ? { firstFrame: { path: frozenInput(shot.startFrame), mimeType: mimeOf(shot.startFrame) } } : {},
      // Without a walk or a camera move there is no movement to follow: the clip takes everything from its prompt.
      ...control ? { videos: [{ path: frozenInput(previs.depthVideo!), mimeType: "video/mp4" }] } : { skipPrevis: true },
      audios: track ? [{ path: frozenInput(track), mimeType: "audio/wav" }] : [],
      loras: loras.map(lora => ({ path: lora.path, strength: 1 })), seed: item.seed, parts: item.parts,
    }, clipSignal);
    let finishedFiles: Record<string, Uint8Array> | undefined;
    // One bounded shot can finish and archive on its generator before a single result transfer.
    const fused = !explicit && production.videos!.length === 1 && !production.input.subtitles && production.ambience !== undefined && production.ambience.every(item => !!item.bed?.videoSha256) && (!production.input.music || !!production.music);
    const work = async () => {
      if (!fused) return generate();
      const length = shotSeconds(production, item.shot);
      const { filters, soundInputs } = filmFilters(production, [item], [length]);
      const inputs = await Promise.all(soundInputs.map(async input => ({ name: "finishSound" + crypto.randomUUID().replaceAll("-", ""), data: await readFile((await resolveWorkspacePath(cwd, input.path)).path), loop: input.loop })));
      const codecs = ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
      const input = ["-t", length.toFixed(3), "-i", "__clipVideo__"];
      const argumentsList = [...input, ...inputs.flatMap(item => [...item.loop ? ["-stream_loop", "-1"] : [], "-i", `/content/${item.name}`]), "-filter_complex", filters.join(";"), "-map", "[picture]", "-map", "[sound]", ...codecs];
      const roughArguments = [...input, "-filter_complex", "[0:v][0:a]concat=n=1:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]", ...codecs];
      return withClipPostprocess({ script: postprocess, inputs, arguments: argumentsList, roughArguments, receive: files => { finishedFiles = files; } }, generate);
    };
    const [video] = await work().catch((error: unknown) => {
      failed.abort(error);
      throw error;
    });
    item.video = video!.path;
    // Only Sulphur renders leave a receipt of the clip kept on their machine; a Remix clip is finished from the workspace.
    item.remote = explicit ? undefined : takeClipArtifact(await readFile((await resolveWorkspacePath(cwd, item.video)).path));
    item.seed = video!.seed;
    if (finishedFiles) {
      const directory = productionDirectory(production.id);
      const film = `${directory}/film.mp4`, roughCut = `${directory}/roughCut.mp4`;
      await writeAtomic((await resolveWorkspacePath(cwd, film, true)).path, finishedFiles["film.mp4"]!);
      await writeAtomic((await resolveWorkspacePath(cwd, roughCut, true)).path, finishedFiles["roughCut.mp4"]!);
      await writeProductionText(cwd, `${directory}/postprocessManifest.json`, new TextDecoder().decode(finishedFiles["result.json"]));
      const timing = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), seconds: z.number().nonnegative(), roughSeconds: z.number().nonnegative() }).parse(JSON.parse(new TextDecoder().decode(finishedFiles["result.json"])));
      (production.timings ??= []).push({ step: "film", start: timing.start, end: timing.end, seconds: timing.seconds }, { step: "roughCut", start: timing.end, end: new Date(Date.parse(timing.end) + timing.roughSeconds * 1000).toISOString(), seconds: timing.roughSeconds });
      Object.assign(production, { film, roughCut });
    }
    await save();
  }));
  // The first failure is the cause; the clips it cancelled only report the cancel.
  if (failed.signal.aborted) throw failed.signal.reason;
  const rejected = results.find(result => result.status === "rejected");
  if (rejected) throw rejected.reason;
}

/** Validate media and dialogue bindings before freezing the exact clip request inputs. */
export async function prepareClipInputs(cwd: string, production: Production, item: ProductionClip, signal: AbortSignal, save: () => Promise<void>) {
  const shot = production.shots!.find(shot => shot.shot === item.shot)!;
  const plan = production.plan?.shots.find(shot => shot.shot === item.shot);
  const previs = production.previs!.find(shot => shot.shot === item.shot)!;
  const dub = production.dub!.shots.find(shot => shot.shot === item.shot)!;
  const control = controlled(production, item.shot);
  if (!plan || !item.prompt || !previs.video || control && !previs.depthVideo || continuedFrom(production, item.shot) !== undefined && !shot.startFrame) throw new Error(`Shot ${item.shot}: missing contract, prompt, previs or the previous clip's last frame`);
  for (const prompt of item.parts ?? [item.prompt]) validateVideoPrompt(prompt);
  for (const [index, line] of dub.lines.entries()) {
    if (line.start !== plan.lines[index]?.start || line.words !== plan.lines[index]?.words || line.speaker !== plan.lines[index]?.speaker || !line.path || !Number.isFinite(line.seconds) || line.start! + line.seconds! > dub.seconds) throw new Error(`Shot ${item.shot}: dialogue differs from its contract or exceeds the shot`);
  }
  if (dub.lines.length !== plan.lines.length || dub.lines.length && !dub.track) throw new Error(`Shot ${item.shot}: missing contracted audio`);
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const length = (path: string) => new Promise<number>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(Number(data.format.duration))));
  const rendered = production.clips!.find(clip => clip.shot === item.shot)!.clip;
  for (const input of [{ path: previs.video, expected: dub.seconds }, ...control ? [{ path: previs.depthVideo!, expected: dub.seconds }] : [], ...dub.lines.map(line => ({ path: line.path!, expected: line.seconds! })), ...dub.track ? [{ path: dub.track, expected: rendered }] : []]) {
    const seconds = await length(input.path);
    if (!Number.isFinite(seconds) || Math.abs(seconds - input.expected) > 0.12) throw new Error(`Shot ${item.shot}: input ${input.path} lasts ${seconds} seconds, expected ${input.expected}`);
  }
  const snapshot = await snapshotMedia(cwd, {
    files: [...shot.startFrame ? [{ path: shot.startFrame, mimeType: mimeOf(shot.startFrame) }] : [], ...control ? [{ path: previs.depthVideo!, mimeType: "video/mp4" }] : [], ...dub.track ? [{ path: dub.track, mimeType: "audio/wav" }] : []],
    outputDirectory: productionDirectory(production.id) + "/inputs/shot" + item.shot,
    binding: clipInputBinding(production, item),
  }, signal);
  if (item.video) {
    const existing = inputSnapshotSchema.parse(item.inputSnapshot);
    if (existing.fingerprint !== snapshot.fingerprint) throw new Error("Rendered inputs changed; regenerate the shot before delivery");
    return existing;
  }
  item.inputSnapshot = snapshot;
  await save();
  return snapshot;
}

function clipInputBinding(production: Production, item: ProductionClip) {
  const contract = production.plan?.shots.find(shot => shot.shot === item.shot);
  const duration = production.clips?.find(clip => clip.shot === item.shot)?.clip;
  if (!contract || !production.plan || !item.prompt || duration === undefined || !Number.isFinite(duration) || duration <= 0) throw new Error("Shot input bindings are incomplete");
  return { contract, voices: production.plan.voices, ...production.references?.length ? { references: production.references } : {}, prompt: item.prompt, ...item.parts ? { parts: item.parts } : {}, ratio: production.input.ratio, quality: production.input.quality, duration };
}

function clipInputSource(production: Production, item: ProductionClip) {
  return createHash("sha256").update(JSON.stringify(clipInputBinding(production, item))).digest("hex");
}

function validatedClips(production: Production) {
  const clips = [...production.videos ?? []].sort((a, b) => a.shot - b.shot);
  const preparationComplete = clips.every(clip => !!production.previs?.find(shot => shot.shot === clip.shot)?.video);
  // A clip that follows no previs and has no dub freezes only its start frame; its prompt binding still counts.
  if (!preparationComplete || !clips.length || clips.length !== production.shots?.length || new Set(clips.map(clip => clip.shot)).size !== clips.length || clips.some(clip => !clip.video || !inputSnapshotSchema.safeParse(clip.inputSnapshot).success || clip.inputSnapshot!.request !== clipInputSource(production, clip) || !production.shots!.some(shot => shot.shot === clip.shot))) throw new Error("Assembly blocked: every shot needs complete preparation and matching frozen inputs");
  return clips;
}

/** Validates delivery files and encoding without an AI judgment of the generated video. */
export async function validateFilm(cwd: string, production: Production, signal: AbortSignal) {
  const clips = validatedClips(production);
  for (const clip of clips) for (const file of clip.inputSnapshot!.files) {
    const bytes = await readFile((await resolveWorkspacePath(cwd, file.path)).path, { signal });
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error(`Shot ${clip.shot}: frozen input changed: ${file.path}`);
  }
  if (!production.film) throw new Error("Final delivery blocked: no film");
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const info = await new Promise<FfprobeData>((resolve, reject) => ffmpeg.ffprobe(production.film!, (error, data) => error ? reject(error) : resolve(data)));
  const video = info.streams.find(stream => stream.codec_type === "video");
  const audio = info.streams.find(stream => stream.codec_type === "audio");
  const expectedSeconds = production.dub!.shots.reduce((sum, shot) => sum + shot.seconds, 0);
  const height = Number(production.input.quality.replace("p", ""));
  const [rw, rh] = production.input.ratio.split(":").map(Number) as [number, number];
  if (!video || !audio || video.codec_name !== "h264" || audio.codec_name !== "aac" || Math.min(Number(video.width), Number(video.height)) !== height || Math.abs(Number(video.width) / Number(video.height) - rw / rh) > 0.01 || !Number.isFinite(Number(info.format.duration)) || Math.abs(Number(info.format.duration) - expectedSeconds) > 0.12 || Math.abs(expectedSeconds - production.input.seconds) > 0.12) throw new Error("Final delivery blocked: codec, dimensions, duration or audio track differs from the delivery contract");
  signal.throwIfAborted();
}

const finished = (command: FfmpegCommand) => new Promise<void>((resolve, reject) => command.on("end", () => resolve()).on("error", reject).run());

/** Each clip as an input cut to its shot's length. */
/**
 * Re-encodes a Remix clip (silent, 16 fps, 720p) to the size and 24 fps Sulphur renders this film at, with a silent
 * stereo track, so it joins the other clips: the cuts concatenate every clip's picture and sound as they are.
 * ACT: 16 fps becomes 24 by repeating frames, which keeps every drawn frame but moves a little unevenly; frame
 * interpolation (RIFE, as Wan workflows often add) would be smoother, at the cost of another model on the machine.
 */
async function conformClip(cwd: string, path: string, resolution: "480p" | "720p" | "1080p", ratio: string, signal: AbortSignal) {
  const [ratioWidth, ratioHeight] = ratio.split(":").map(Number) as [number, number];
  const short = Number(resolution.replace("p", ""));
  const long = Math.round(short * Math.max(ratioWidth, ratioHeight) / Math.min(ratioWidth, ratioHeight) / 2) * 2;
  const [width, height] = ratioWidth >= ratioHeight ? [long, short] : [short, long];
  const output = path.replace(/\.mp4$/, "Conformed.mp4");
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  await finished(ffmpeg((await resolveWorkspacePath(cwd, path)).path)
    .complexFilter([`[0:v]scale=${width}:${height}:flags=lanczos,fps=24,setsar=1[v]`, "anullsrc=r=48000:cl=stereo[a]"], ["v", "a"])
    .outputOptions(["-shortest", "-c:v libx264", "-crf 18", "-pix_fmt yuv420p", "-c:a aac", "-b:a 192k", "-movflags +faststart"])
    .output((await resolveWorkspacePath(cwd, output, true)).path));
  return output;
}

const cutClips = (command: FfmpegCommand, production: Production, clips: ProductionClip[]) =>
  clips.reduce((current, clip) => current.input(clip.video!).inputOptions("-t", shotSeconds(production, clip.shot).toFixed(3)), command);

/**
 * Joins the clips in shot order, each cut to its shot's length, into the rough cut, re-encoded to one format so clips of
 * any source join cleanly.
 */
export async function joinRoughCut(cwd: string, production: Production, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const clips = validatedClips(production);
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
 * length, takes speech from the original dialogue tracks and lays the music and each ambience bed underneath,
 * ducks the music while people speak as the soundtrack mix node does, and burns in each dubbed line as a subtitle while it
 * is spoken and long enough to read. A bed runs on from shot to shot of its place, so a cut inside a scene does not
 * restart it.
 */
function filmFilters(production: Production, clips: ProductionClip[], lengths: number[], subtitles?: string) {
  const total = lengths.reduce((sum, length) => sum + length, 0);
  // Each bed is one looped input, split into the stretches its place's shots take in order; a shot of a place with no
  // bed lays silence there.
  const uploadedAmbience = production.references?.find(item => item.use === "ambience");
  const beds = [...new Map([...((production.ambience ?? []).flatMap(item => item.bed ? [[item.place, item.bed.path] as const] : [])), ...uploadedAmbience ? production.assets!.places.map(place => [place.name, uploadedAmbience.path] as const) : []]).entries()];
  const bedInput = (place: string) => beds.findIndex(([name]) => name === place);
  const firstBed = clips.length + (production.music ? 1 : 0);
  const dialogue = clips.flatMap(clip => {
    const shot = production.dub!.shots.find(shot => shot.shot === clip.shot);
    if (!shot) throw new Error(`Missing dialogue plan for shot ${clip.shot}`);
    if (!shot.lines.length) return [];
    if (!shot.track) throw new Error(`Missing original dialogue track for shot ${clip.shot}`);
    return [{ shot: clip.shot, path: shot.track }];
  });
  const soundInputs = [
    ...production.music ? [{ path: production.music, loop: true }] : [],
    ...beds.map(([, path]) => ({ path, loop: true })),
    ...dialogue.map(({ path }) => ({ path, loop: false })),
  ];
  const voiceInput = new Map(dialogue.map((track, index) => [track.shot, firstBed + beds.length + index]));
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
      return `[${firstBed + input}:a]${uploadedAmbience?.path === beds[input]![1] ? "loudnorm=I=-38:TP=-2:LRA=11,aresample=48000,aformat=channel_layouts=stereo," : ""}asplit=${uses}${Array.from({ length: uses }, (_, use) => `[bed${input}u${use}]`).join("")}`;
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
    ...clips.map((clip, index) => voiceInput.has(clip.shot)
      ? `[${voiceInput.get(clip.shot)}:a]atrim=duration=${lengths[index]},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${index}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${lengths[index]}[a${index}]`),
    `${clips.map((_, index) => `[${index}:v][a${index}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][dialogue]`,
    // The subtitle file sits in the production folder, a path of plain characters relative to the workspace FFmpeg runs in.
    subtitles ? `[v]subtitles=filename=${subtitles}:force_style='FontSize=24,Outline=2,Shadow=1,MarginV=24'[picture]` : "[v]null[picture]",
    ...production.music ? [`[${clips.length}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total},asetpts=PTS-STARTPTS,volume=${musicVolume},afade=t=in:d=2,afade=t=out:st=${Math.max(0, total - 3)}:d=3[music]`] : [],
    ...ambience,
    production.music ? "[dialogue]asplit=2[voice][key];[music][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked]" : "[dialogue]anull[voice]",
    `${layers.join("")}${layers.length > 1 ? `amix=inputs=${layers.length}:normalize=0:duration=first,` : ""}alimiter=limit=0.95:level=disabled:latency=1[sound]`,
  ];
  return { filters, soundInputs };
}

export async function finishFilm(cwd: string, production: Production, signal: AbortSignal) {
  if (!production.ambience || production.ambience.some(item => !item.bed?.videoSha256)) throw new Error("Final assembly needs every planned ambience recording");
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const duration = (path: string) => new Promise<number>((resolve, reject) => ffmpeg.ffprobe(path, (error, data) => error ? reject(error) : resolve(Number(data.format.duration) || 0)));
  const clips = validatedClips(production);
  const lengths = await Promise.all(clips.map(async clip => {
    const actual = await duration(clip.video!);
    const expected = shotSeconds(production, clip.shot);
    if (!Number.isFinite(actual) || actual + 0.05 < expected) throw new Error(`Shot ${clip.shot}: generated clip is shorter than its contracted duration`);
    return expected;
  }));
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
  const { filters, soundInputs } = filmFilters(production, clips, lengths, subtitles);
  const output = `${folder}/film.mp4`;
  // Every clip must still be on a machine for the film to be cut there; a Remix clip never is, so such films are cut here.
  const resident = subtitles || clips.some(clip => !clip.remote) ? [] : clips.map(clip => clipArtifactSchema.parse(clip.remote));
  // The film is cut on a machine that still holds a clip; once none is left in the pool, it is cut here.
  const target = resident.findLast(artifact => colabSessionName(artifact.lane) === artifact.session);
  if (target) {
    const job = "finish" + crypto.randomUUID().replaceAll("-", "");
    const uploads: { name: string; data: string | Uint8Array }[] = [];
    const inputs: { path: string; bytes: number; sha256: string }[] = [];
    const argumentsList: string[] = [];
    for (const [index, clip] of clips.entries()) {
      const artifact = resident[index]!;
      const bytes = await readFile((await resolveWorkspacePath(cwd, clip.video!)).path);
      if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("Archived clip differs from its receipt");
      const path = artifact.session === target.session ? artifact.path : `/content/${job}Clip${index}.mp4`;
      if (artifact.session !== target.session) uploads.push({ name: `${job}Clip${index}.mp4`, data: bytes });
      inputs.push({ path, bytes: artifact.bytes, sha256: artifact.sha256 });
      argumentsList.push("-t", lengths[index]!.toFixed(3), "-i", path);
    }
    for (const [index, input] of soundInputs.entries()) {
      const bytes = await readFile((await resolveWorkspacePath(cwd, input.path)).path);
      const name = `${job}Sound${index}`;
      uploads.push({ name, data: bytes });
      inputs.push({ path: `/content/${name}`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      argumentsList.push(...input.loop ? ["-stream_loop", "-1"] : [], "-i", `/content/${name}`);
    }
    argumentsList.push("-filter_complex", filters.join(";"), "-map", "[picture]", "-map", "[sound]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
    uploads.push({ name: `${job}.json`, data: JSON.stringify({ inputs, arguments: argumentsList }) });
    const [data, receipt] = await useExistingColabSession(target.lane, target.session, (session, jobSignal) => session.job({ script: postprocess, uploads, env: { PRODUCTION_FINISH_JOB: job }, outputs: [`/content/${job}.mp4`, `/content/${job}Result.json`] }, jobSignal), signal);
    const manifest = z.object({ bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), seconds: z.number().nonnegative(), inputs: z.array(z.object({ path: z.string(), bytes: z.number().int().positive(), sha256: z.string() })) }).parse(JSON.parse(new TextDecoder().decode(receipt)));
    if (manifest.bytes !== data!.length || manifest.sha256 !== createHash("sha256").update(data!).digest("hex")) throw new Error("Final film digest mismatch");
    await writeAtomic((await resolveWorkspacePath(cwd, output, true)).path, data!);
    await writeProductionText(cwd, `${folder}/postprocessManifest.json`, JSON.stringify({ ...manifest, session: target.session, inputs, arguments: argumentsList }, null, 2));
    return output;
  }
  const command = cutClips(ffmpeg(), production, clips);
  for (const input of soundInputs) {
    command.input(input.path);
    if (input.loop) command.inputOptions("-stream_loop", "-1");
  }
  command.complexFilter(filters, ["picture", "sound"])
    .outputOptions(["-c:v libx264", "-crf 18", "-pix_fmt yuv420p", "-c:a aac", "-b:a 192k", "-movflags +faststart"]).output(output);
  await finished(command);
  return output;
}
