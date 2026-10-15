import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { fillDialogue, parseDialogue, speakerIds, videoPromptInstructions } from "@toonflow/node-shared/videoPrompt";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { generateMedia } from "@/utils/media/generation";
import { stopMinimaxH3WhenIdle } from "@/utils/media/minimaxH3";
import { productionDirectory, type Production } from "./state";

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
 * Renders every clip from its keyframe as the first frame, its previs as the blocking reference, its dubbed track and
 * its cast's H3 LoRAs. All are requested at once and run one after another on one Colab machine.
 */
export async function renderClips(cwd: string, production: Production, resolution: "480p" | "720p" | "1080p", signal: AbortSignal, save: () => Promise<void>) {
  try {
    await Promise.all(production.videos!.filter(item => !item.video).map(async item => {
      const keyframe = production.keyframes!.shots.find(shot => shot.shot === item.shot)!;
      const previs = production.previs!.find(shot => shot.shot === item.shot);
      const track = production.dub!.shots.find(shot => shot.shot === item.shot)?.track;
      const loras = keyframe.cast.flatMap(name => production.assets!.characters.find(person => person.name === name)?.loras?.filter(lora => lora.family === "h3") ?? []);
      const [video] = await generateMedia(cwd, "video", {
        ...h3, mode: "startFrameOptional", prompt: item.prompt!, duration: production.clips!.find(clip => clip.shot === item.shot)!.clip, resolution, ratio: production.input.ratio,
        generateAudio: true, outputDirectory: `${productionDirectory(production.id)}/clips`,
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
