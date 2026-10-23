import type { BrowserFfmpegFactory } from "@toonflow/nodes-scaffold/runtime";
import { probeMedia, runCommand } from "@toonflow/node-shared/ffmpegCommand";
import { t, translate } from "@toonflow/i18n/vue";

/**
 * Joins workspace videos end to end into one H.264/AAC MP4. Every clip is fitted to the first clip's frame size
 * (letterboxed, never stretched) at the first clip's frame rate, and a clip without sound gets silence, so picture and sound
 * stay in sync at every cut. With `smoothCuts`, each clip's sound fades in and out over 50 ms, which removes the click
 * of a cut without changing any clip's length.
 */
export async function concatVideos(ffmpeg: BrowserFfmpegFactory, sources: string[], output: string, smoothCuts: boolean, signal?: AbortSignal) {
  if (sources.length < 2) throw new Error(translate("Connect at least two videos to join"));
  const clips: { video: number; audio?: number; duration: number; width: number; height: number; frameRate?: string }[] = [];
  for (const source of sources) {
    const media = await probeMedia(ffmpeg, source, signal);
    const video = media.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const duration = Number(video?.duration ?? media.format.duration);
    if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) throw new Error(t`${source} is not a playable video`);
    clips.push({ video: video.index, audio: media.streams.find(stream => stream.codec_type === "audio")?.index, duration, width: video.width, height: video.height, frameRate: video.r_frame_rate });
  }
  // H.264 needs even dimensions.
  const width = Math.ceil(clips[0]!.width / 2) * 2;
  const height = Math.ceil(clips[0]!.height / 2) * 2;
  // Keeping the source rate avoids repeated frames, such as 24 fps Sulphur 2 clips forced to 30; 30 only when it is unknown.
  const frameRate = /^[1-9]\d*\/[1-9]\d*$/.test(clips[0]!.frameRate ?? "") ? clips[0]!.frameRate! : "30";
  const fade = (duration: number) => smoothCuts ? `,afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, duration - 0.05)}:d=0.05` : "";
  const filters = clips.flatMap((clip, index) => [
    `[${index}:${clip.video}]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,`
      + `setsar=1,fps=${frameRate},format=yuv420p,trim=duration=${clip.duration},setpts=PTS-STARTPTS[v${index}]`,
    clip.audio === undefined
      ? `anullsrc=r=48000:cl=stereo,atrim=duration=${clip.duration}[a${index}]`
      : `[${index}:${clip.audio}]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${clip.duration},asetpts=PTS-STARTPTS${fade(clip.duration)}[a${index}]`,
  ]);
  filters.push(`${clips.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][a]`);
  const command = ffmpeg(sources[0]);
  for (const source of sources.slice(1)) command.addInput(source);
  command.complexFilter(filters.join(";")).output(output).videoCodec("libx264").audioCodec("aac").audioBitrate(192).format("mp4")
    .outputOptions("-map", "[v]", "-map", "[a]", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  await runCommand(command, signal);
  const duration = Number((await probeMedia(ffmpeg, output, signal)).format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(translate("The joined video is not valid"));
  return { duration, width, height };
}
