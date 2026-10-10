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
  /** Gain of the video's own audio, 0 replaces it with the dubbing. */
  originalVolume: number;
};

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
  if (!audio.streams.some(stream => stream.codec_type === "audio")) throw new Error("配音输入不包含音轨");

  const filters = [`[1:a:0]adelay=${Math.round(options.start * 1000)}:all=1,volume=${options.voiceVolume}[voice]`];
  if (options.originalVolume > 0 && video.streams.some(stream => stream.codec_type === "audio")) {
    filters.push(`[0:a:0]volume=${options.originalVolume}[original]`, "[original][voice]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad[mix]");
  } else {
    filters.push("[voice]apad[mix]");
  }
  // ACT: The picture is copied without re-encoding, so codecs that MP4 cannot hold (e.g. ProRes) fail here;
  // re-encode with libx264 if such sources ever need support. apad plus the duration cap keeps the video's length.
  const command = ffmpeg(options.videoPath).input(options.audioPath).complexFilter(filters)
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
