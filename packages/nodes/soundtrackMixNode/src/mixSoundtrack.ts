import type { BrowserFfmpegFactory } from "@toonflow/nodes-scaffold/runtime";
import { probeMedia, runCommand } from "@toonflow/node-shared/ffmpegCommand";
import { t, translate } from "@toonflow/i18n/vue";

export type SoundtrackOptions = {
  /** Track level from 0 to 1. */
  volume: number;
  /** Fade-in and fade-out length of the tracks in seconds. */
  fade: number;
  /** Lowers the tracks while the video's own sound (dialogue, effects) plays. */
  duck: boolean;
};

/**
 * Lays one or more audio tracks, such as music and ambience, under a workspace video: each track is looped or cut to
 * the video's length, faded and set to `volume`, then mixed with the video's own sound. The picture is copied as is.
 */
export async function mixSoundtrack(ffmpeg: BrowserFfmpegFactory, video: string, tracks: string[], output: string, { volume, fade, duck }: SoundtrackOptions, signal?: AbortSignal) {
  if (!tracks.length) throw new Error(translate("Connect at least one audio track"));
  const media = await probeMedia(ffmpeg, video, signal);
  const picture = media.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const duration = Number(picture?.duration ?? media.format.duration);
  if (!picture || !Number.isFinite(duration) || duration <= 0) throw new Error(t`${video} is not a playable video`);
  const ownSound = media.streams.find(stream => stream.codec_type === "audio")?.index;
  const trackStreams: number[] = [];
  for (const track of tracks) {
    const stream = (await probeMedia(ffmpeg, track, signal)).streams.find(item => item.codec_type === "audio");
    if (!stream) throw new Error(t`${track} has no sound`);
    trackStreams.push(stream.index);
  }
  const length = Math.min(fade, duration / 2);
  const fades = length > 0 ? `,afade=t=in:d=${length},afade=t=out:st=${duration - length}:d=${length}` : "";
  const filters = trackStreams.map((stream, index) =>
    `[${index + 1}:${stream}]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=${volume}${fades}[t${index}]`);
  filters.push(tracks.length > 1 ? `${trackStreams.map((_, index) => `[t${index}]`).join("")}amix=inputs=${tracks.length}:normalize=0[bed]` : "[t0]anull[bed]");
  if (ownSound === undefined) filters.push("[bed]alimiter=limit=0.95[a]");
  else {
    filters.push(`[0:${ownSound}]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${duration}[own]`);
    // ACT: The whole of the video's own sound keys the ducking, ambience included: sound above about -30 dBFS lowers the
    // tracks by roughly 8 to 13 dB at dialogue level, and quieter ambience does not. Separate a dialogue stem if louder
    // ambience keeps the music down too often.
    filters.push(duck
      ? "[own]asplit=2[voice][key];[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]"
      : "[own][bed]amix=inputs=2:normalize=0,alimiter=limit=0.95[a]");
  }
  const command = ffmpeg(video);
  // Each track repeats until the video ends; atrim above cuts it to the video's length.
  for (const track of tracks) command.addInput(track).inputOptions("-stream_loop", "-1");
  command.complexFilter(filters.join(";")).output(output).format("mp4")
    .outputOptions("-map", `0:${picture.index}`, "-c:v", "copy", "-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-t", String(duration), "-movflags", "+faststart");
  await runCommand(command, signal);
  const result = Number((await probeMedia(ffmpeg, output, signal)).format.duration);
  if (!Number.isFinite(result) || result <= 0) throw new Error(translate("The mixed video is not valid"));
  return { duration: result };
}
