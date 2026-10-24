import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { mkdir, readFile } from "@toonflow/file";
import { closingSentence, validateVideoPrompt } from "@toonflow/node-shared/videoPrompt";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { generateMedia } from "@/utils/media/generation";
import { maxClipSeconds, takeClipArtifact } from "@/utils/media/sulphur";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, writeProductionText, type Production } from "./state";

export type ProductionAmbience = { place: string; query: string; bed?: { path: string; video: string; prompt: string; videoSha256: string; seed?: number } };

/** Describes the audible environment for independent ambience generation and the final mix. */
export function ambiencePrompt(places: { name: string; look: string }[], outline: string) {
  return [
    "For each place below, describe its steady environmental sound in one to three concise English sentences: moving air, leaf rustling, rain, room tone or other appropriate continuous physical sounds. Exclude speech, human vocalizations, music and isolated action effects.",
    "Use an empty string only when the creator explicitly requires silence or no ambience layer.",
    "The authoritative outline determines required ambience. Supplied dialogue has no ambience bed; it will be mixed with separately generated ambience.",
    "Output only JSON, one key per place name exactly as written, its sound description as the value.",
    `Authoritative outline: ${outline}`,
    ...places.map(place => `${place.name}: ${place.look}`),
  ].join("\n");
}

// Match the selected mix: ambience remains about 20 dB below dialogue normalized to -16 LUFS.
const bedLevel = -38;
const finished = (command: FfmpegCommand) => new Promise<string>((resolve, reject) => command.on("end", (_: unknown, log: string | null) => resolve(log ?? "")).on("error", reject).run());

// In the caption format of the sulphur-prompt-writing skill: style and camera, the place, what moves, the sound.
function ambienceVideoPrompt(place: string, query: string) {
  const soundscape = query.trim().replace(/\s+/g, " ");
  if (!soundscape || soundscape.length > 1000) throw new Error("Ambience needs a bounded sound description");
  const prompt = [
    "In this photorealistic live-action video, the camera remains static at a wide shot of an empty place where nobody is present and nobody enters.",
    `${place.trim().replace(/[.!?]+$/, "")}.`,
    "Nothing moves except what the air moves, such as a curtain, leaves or rain.",
    `${soundscape.replace(/[.!?]*$/, ".")}`,
    "The sound is continuous and clearly audible with natural variation, with no voices, singing or music.",
    closingSentence,
  ].join(" ");
  validateVideoPrompt(prompt);
  return prompt;
}

/** Generates independent beds on the production's video workers, at 480p since only their sound is kept; each completed bed is checkpointed. */
export async function generateAmbience(cwd: string, production: Production, signal: AbortSignal, save: () => Promise<void>) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const folder = `${productionDirectory(production.id)}/ambience`;
  await mkdir((await resolveWorkspacePath(cwd, folder, true)).path, { recursive: true });
  const pending = production.ambience!.entries();
  const results = await Promise.allSettled(Array.from({ length: Math.min(2, production.ambience!.length) }, async () => {
    for (const [index, item] of pending) {
      signal.throwIfAborted();
      if (item.bed?.videoSha256) continue;
      const place = production.assets!.places.find(place => place.name === item.place);
      const image = place?.views?.[0];
      if (!image) throw new Error(`Missing reviewed environment image for ${item.place}`);
      const sceneSeconds = production.dub!.shots.filter(shot => production.plan!.shots.find(plan => plan.shot === shot.shot)?.place === item.place).reduce((sum, shot) => sum + shot.seconds, 0);
      if (sceneSeconds <= 0) throw new Error(`Ambience has no delivered scene: ${item.place}`);
      const duration = Math.min(maxClipSeconds, Math.max(5, Math.ceil(sceneSeconds)));
      const prompt = `${folder}/bed${index + 1}Prompt.txt`;
      const text = ambienceVideoPrompt(place!.look, item.query);
      await writeProductionText(cwd, prompt, text);
      const [video] = await generateMedia(cwd, "video", {
        providerId: "sulphur", modelId: "sulphur_2", mode: "endFrameOptional", prompt: text,
        duration, resolution: "480p", ratio: production.input.ratio, generateAudio: true,
        firstFrame: { path: image, mimeType: /\.jpe?g$/i.test(image) ? "image/jpeg" : "image/png" },
        // This renders a stationary empty environment solely for its native audio, without actor choreography.
        skipPrevis: true, outputDirectory: folder,
      }, signal);
      if (!video) throw new Error(`Sulphur 2 returned no ambience video for ${item.place}`);
      const artifact = takeClipArtifact(await readFile((await resolveWorkspacePath(cwd, video.path)).path));
      const measured = await finished(ffmpeg(video.path).noVideo().audioFilters("volumedetect").format("null").output("-"));
      const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(measured)?.[1]);
      if (!Number.isFinite(mean)) throw new Error(`Sulphur 2 returned no measurable ambience audio for ${item.place}`);
      const path = `${folder}/bed${index + 1}.wav`;
      await finished(ffmpeg(video.path).noVideo().audioFilters([`volume=${(bedLevel - mean).toFixed(1)}dB`, "alimiter=limit=0.25:level=disabled:latency=1", "aresample=48000", "aformat=channel_layouts=stereo"]).audioCodec("pcm_s24le").output(path));
      item.bed = { path, video: video.path, prompt, videoSha256: artifact.sha256, seed: video.seed };
      await save();
    }
  }));
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
}
