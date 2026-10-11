import type { BrowserFfmpegFactory } from "@toonflow/nodes-scaffold/runtime";
import { probeMedia, runCommand } from "@toonflow/node-shared/ffmpegCommand";

export type DubbingOptions = {
  videoPath: string;
  audioPath: string;
  outputPath: string;
  /** Seconds into the video where the dubbing starts. */
  start: number;
  /** Gain of the dubbing track, 1 keeps it unchanged. */
  voiceVolume: number;
  /** Gain of the video's own audio while the dubbing plays; before and after the dubbing it stays at full volume. */
  originalVolume: number;
  /** Optional background music, levelled 6 dB under the voice and ducked while the voice plays. */
  musicPath?: string;
};

// Mix rule: the voice sits 6 dB above the music (-16 vs -22 LUFS) and the music ducks under it through a sidechain.
const voiceLoudness = -16;
const musicLoudness = -22;

/** Mixes a dubbing track into a video. The caller owns the output directory and failure cleanup; inputs are never overwritten. */
export async function dubVideo(ffmpeg: BrowserFfmpegFactory, options: DubbingOptions, signal?: AbortSignal) {
  const gains = [options.voiceVolume, options.originalVolume];
  if (gains.some(gain => !Number.isFinite(gain) || gain < 0 || gain > 2)) throw new Error("音量须在 0% 至 200% 之间");
  const video = await probeMedia(ffmpeg, options.videoPath, signal);
  const picture = video.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!picture) throw new Error("视频输入不包含画面");
  const duration = Number(video.format.duration ?? picture.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取有效的视频时长");
  if (!Number.isFinite(options.start) || options.start < 0 || options.start >= duration) throw new Error("配音开始时间须在 0 到视频时长之间");
  const audio = await probeMedia(ffmpeg, options.audioPath, signal);
  const voice = audio.streams.find(stream => stream.codec_type === "audio");
  if (!voice) throw new Error("配音输入不包含音轨");
  const voiceLength = Number(audio.format.duration ?? voice.duration);
  if (!Number.isFinite(voiceLength) || voiceLength <= 0) throw new Error("无法读取有效的配音时长");

  if (options.musicPath) {
    const music = await probeMedia(ffmpeg, options.musicPath, signal);
    if (!music.streams.some(stream => stream.codec_type === "audio")) throw new Error("Music input has no audio track");
  }
  const delay = `adelay=${Math.round(options.start * 1000)}:all=1`;
  const filters = options.musicPath ? [
    `[1:a:0]${delay},loudnorm=I=${voiceLoudness}:TP=-1.5:LRA=11,aresample=48000,volume=${options.voiceVolume},asplit=2[voice][voiceKey]`,
    `[2:a:0]loudnorm=I=${musicLoudness}:TP=-2:LRA=11,aresample=48000[musicLevel]`,
    "[musicLevel][voiceKey]sidechaincompress=threshold=0.05:ratio=6:attack=20:release=400[music]",
  ] : [`[1:a:0]${delay},volume=${options.voiceVolume}[voice]`];
  const voiceBus = options.musicPath ? "[voice][music]" : "[voice]";
  const voiceInputs = options.musicPath ? 2 : 1;
  if (video.streams.some(stream => stream.codec_type === "audio")) {
    // Ducking: the original audio only drops while the dubbing plays and eases back over `ramp` seconds outside that span,
    // so ambience before and after the dubbing keeps its full volume.
    const ramp = 0.25;
    const end = Math.min(duration, options.start + voiceLength);
    const inside = `min(1,max(0,(t-(${options.start - ramp}))/${ramp}))*min(1,max(0,((${end + ramp})-t)/${ramp}))`;
    filters.push(
      `[0:a:0]volume='1-(${1 - options.originalVolume})*${inside}':eval=frame[original]`,
      `[original]${voiceBus}amix=inputs=${voiceInputs + 1}:duration=longest:dropout_transition=0:normalize=0,apad[mix]`,
    );
  } else {
    filters.push(voiceInputs > 1 ? `${voiceBus}amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad[mix]` : "[voice]apad[mix]");
  }
  // ACT: The picture is copied without re-encoding, so codecs that MP4 cannot hold (e.g. ProRes) fail here;
  // re-encode with libx264 if such sources ever need support. apad plus the duration cap keeps the video's length.
  const command = ffmpeg(options.videoPath).input(options.audioPath);
  if (options.musicPath) command.input(options.musicPath);
  command.complexFilter(filters)
    .output(options.outputPath).videoCodec("copy").audioCodec("aac").audioBitrate(192).duration(duration).format("mp4")
    .outputOptions("-map", `0:${picture.index}`, "-map", "[mix]", "-movflags", "+faststart");
  await runCommand(command, signal);
  const result = await probeMedia(ffmpeg, options.outputPath, signal);
  const resultDuration = Number(result.format.duration);
  if (!Number.isFinite(resultDuration) || resultDuration <= 0 || !["video", "audio"].every(type => result.streams.some(stream => stream.codec_type === type))) {
    throw new Error("生成的视频文件无效");
  }
  return { duration: resultDuration, width: picture.width, height: picture.height };
}
