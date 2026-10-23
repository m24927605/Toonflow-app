import { z } from "zod";
import { createHash } from "node:crypto";
import type { FfmpegCommand, FfprobeData } from "@toonflow/ffmpeg";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { finishPrompt, shotDialogue, validateVideoPrompt, videoPromptInstructions } from "@toonflow/node-shared/videoPrompt";
import { findOnScreenText } from "@toonflow/tools-scaffold/onScreenText";
import { readFile, writeAtomic } from "@toonflow/file";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { snapshotMedia, inputSnapshotSchema } from "@/utils/media/snapshot";
import { longTakeParts, takeClipArtifact, withClipPostprocess, clipArtifactSchema, type ClipArtifact } from "@/utils/media/sulphur";
import { useExistingColabSession } from "@/utils/media/colabPool";
import postprocess from "./postprocessColab.py" with { type: "text" };
import { ReplyCutError, replyJson } from "./review";
import { maxLoras, shotReferences } from "./shots";
import { clipSeconds, type ProductionDub } from "./dub";
import { productionDirectory, writeProductionText, type Production } from "./state";
import { gazeDescriptions } from "./plan";

/** A generated shot and its exact prompt and seed; generated video is not AI-reviewed. */
export type ProductionClip = { shot: number; prompt?: string; parts?: string[]; video?: string; seed?: number; remote?: ClipArtifact; inputSnapshot?: z.infer<typeof inputSnapshotSchema> };

const sulphur = { providerId: "sulphur", modelId: "sulphur_2_q8" };
/**
 * How long a shot plays in the film: its time in the shot list, or longer when its lines need it. Sulphur 2 renders
 * whole seconds, so the film cuts each clip to this.
 */
const shotSeconds = (production: Production, shot: number) => production.dub!.shots.find(item => item.shot === shot)!.seconds;
const mimeOf = (path: string) => /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.mp4$/i.test(path) ? "video/mp4" : /\.wav$/i.test(path) ? "audio/wav" : "image/png";
/** Whether a shot's clip follows its previs depth video, which only a staged shot has. */
const controlled = (production: Production, shot: number) => !production.previs!.find(item => item.shot === shot)!.referenceOnly;

/** The people of a shot as its prompt names them: by name and LoRA trigger word, with their look and opening state. */
function promptPeople(production: Production, shot: number) {
  const row = production.shots!.find(item => item.shot === shot)!;
  const previs = production.previs!.find(item => item.shot === shot)!;
  const contract = production.plan!.shots.find(item => item.shot === shot)!;
  return shotReferences(row, production.assets!, previs.framed).people.slice(0, 8).map(({ person }) => {
    const outfit = person.outfits?.find(item => item.name === row.outfits[person.name]);
    const actor = contract.actors.find(item => item.name === person.name);
    const trigger = person.triggers?.ltx ?? person.loras?.find(lora => lora.family === "ltx")?.trigger;
    return {
      name: person.name, trigger, look: `${person.look}${outfit ? ` Wearing ${outfit.look}` : ""}`,
      opening: previs.framed.opening.includes(person.name) ? `${actor ? `${actor.pose} Looking ${gazeDescriptions[actor.gaze]}.` : "In the frame."}` : "Not in the first frame; enters during the shot.",
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
    const people = promptPeople(production, span.shot);
    const names = new Map(people.map(person => [person.name, [person.name, ...person.trigger ? [person.trigger] : []]]));
    const control = controlled(production, span.shot);
    const opening = `${people.filter(person => previs.framed.opening.includes(person.name)).map(person => `${person.name}: ${person.opening}`).join(" ") || "Nobody is in the frame."}${place ? ` The place: ${place.look}` : ""}`;
    const kept = shotSeconds(production, span.shot);
    const cut = kept < clip ? `The film keeps only the first ${kept.toFixed(1)} seconds of this clip, the shot's length: everything the row asks for happens within them, and afterwards everyone carries on calmly, their eyes still where the shot ends them looking.` : undefined;
    const instructionsOf = (part: typeof span, duration: number, note?: string) => `${videoPromptInstructions(part, 1, { duration, style: "photorealistic live-action", opening, people, place: place?.look, control, blocking: previs.blocking, note })}\n\nAuthoritative production contract: ${JSON.stringify(production.plan?.shots.find(item => item.shot === span.shot))}\n\nOriginal script ({{ref 1}}):\n${script}\n\nShot list ({{ref 2}}):\n${shotList}`;
    // Has the text model write the prompt and fills in the lines of `partLines`; a draft that breaks a rule is rewritten
    // with the error, at most five times.
    const write = async (instructions: string, partLines = lines) => {
      const finish = (draft: string) => {
        const prompt = finishPrompt(draft, partLines, names);
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
          if (!fixes) throw error;
          return valid(await complete(`${instructions}\n\nYour draft:\n${draft}\n\nFix this and output the whole prompt again: ${error instanceof Error ? error.message : String(error)}`), fixes - 1);
        }
      };
      return valid(await complete(instructions));
    };
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
 * Renders each clip not rendered yet into `folder`: from its keyframe as the first frame, following its previs depth
 * video when the shot is staged, locked to its dubbed track, with those people's LoRAs and its own seed. All are
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
    const loras = references.people.flatMap(({ person }) => person.loras?.filter(lora => lora.family === "ltx") ?? []).slice(0, maxLoras);
    const snapshot = await prepareClipInputs(cwd, production, item, clipSignal, save);
    const frozenInput = (path: string) => {
      const frozen = snapshot.files.find(item => item.source === path)?.path;
      if (!frozen) throw new Error(`Missing frozen clip input: ${path}`);
      return frozen;
    };
    const control = controlled(production, item.shot);
    const generate = () => generateMedia(cwd, "video", {
      ...sulphur, mode: control ? "videoControl" : "endFrameOptional", prompt: item.prompt!, duration: production.clips!.find(clip => clip.shot === item.shot)!.clip, resolution, ratio: production.input.ratio,
      generateAudio: true, outputDirectory: `${productionDirectory(production.id)}/${folder}`,
      firstFrame: { path: frozenInput(shot.keyframe!), mimeType: mimeOf(shot.keyframe!) },
      // A reference shot's previs is its keyframe: the opening it planned, held still, with no movement to follow.
      ...control ? { videos: [{ path: frozenInput(previs.depthVideo!), mimeType: "video/mp4" }] } : { skipPrevis: true },
      audios: track ? [{ path: frozenInput(track), mimeType: "audio/wav" }] : [],
      loras: loras.map(lora => ({ path: lora.path, strength: 1 })), seed: item.seed, parts: item.parts,
    }, clipSignal);
    let finishedFiles: Record<string, Uint8Array> | undefined;
    // One bounded shot can finish and archive on its generator before a single result transfer.
    const fused = production.videos!.length === 1 && !production.input.subtitles && production.ambience !== undefined && production.ambience.every(item => !!item.bed?.videoSha256) && (!production.input.music || !!production.music);
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
    item.remote = takeClipArtifact(await readFile((await resolveWorkspacePath(cwd, item.video)).path));
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
  if (!plan || !item.prompt || !previs.layout || !previs.video || !shot.keyframe || control && !previs.depthVideo) throw new Error(`Shot ${item.shot}: missing contract, prompt, keyframe or previs`);
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
    files: [{ path: shot.keyframe, mimeType: mimeOf(shot.keyframe) }, ...control ? [{ path: previs.depthVideo!, mimeType: "video/mp4" }] : [], ...dub.track ? [{ path: dub.track, mimeType: "audio/wav" }] : []],
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
  const preparationComplete = clips.every(clip => {
    const plan = production.execution?.shots.find(shot => shot.shot === clip.shot);
    const guide = production.previs?.find(shot => shot.shot === clip.shot);
    if (!plan || !guide?.layout || !guide.video) return false;
    return plan.preparation === "reference" ? guide.referenceOnly === true : !guide.referenceOnly;
  });
  if (!preparationComplete || !clips.length || clips.length !== production.shots?.length || new Set(clips.map(clip => clip.shot)).size !== clips.length || clips.some(clip => !clip.video || !inputSnapshotSchema.safeParse(clip.inputSnapshot).success || !clip.inputSnapshot!.files.length || clip.inputSnapshot!.request !== clipInputSource(production, clip) || !production.shots!.some(shot => shot.shot === clip.shot))) throw new Error("Assembly blocked: every shot needs complete preparation and matching frozen inputs");
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
 * length, takes speech from the original Drama-3 tracks and lays the music and each ambience bed underneath,
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
  if (!subtitles) {
    const resident = clips.map(clip => clipArtifactSchema.parse(clip.remote));
    const target = resident.at(-1)!;
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
