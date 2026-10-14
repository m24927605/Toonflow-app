import type { BrowserFfmpegFactory } from "@toonflow/ffmpeg/browser";
import { probeMedia, runCommand } from "@toonflow/node-shared/ffmpegCommand";
import { translate } from "@toonflow/i18n/vue";

export type VideoProcessingOptions = {
  action: "extractAudio" | "separate" | "trim" | "fps30" | "lastFrame";
  audioPath?: string;
  imagePath?: string;
  videoPath?: string;
  start?: number;
  end?: number;
};

function normalizePath(path: string) {
  if (!path || /[\x00-\x1f]/.test(path) || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(path) || path.split(/[\\/]+/).includes("..")) {
    throw new Error("视频处理必须使用工作区相对路径");
  }
  return path.split(/[\\/]+/).filter(part => part && part !== ".").join("/").toLowerCase();
}

/** Directory creation, unique file names and failure cleanup are the caller's job; the original video is always kept. */
export async function processVideo(ffmpeg: BrowserFfmpegFactory, source: string, options: VideoProcessingOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sourcePath = normalizePath(source);
  if (!["extractAudio", "separate", "trim", "fps30", "lastFrame"].includes(options.action)) throw new Error("未知的视频处理操作");
  const lastFrame = options.action === "lastFrame";
  const needsAudio = options.action === "extractAudio" || options.action === "separate";
  const needsVideo = options.action !== "extractAudio" && !lastFrame;
  if (lastFrame && !options.imagePath) throw new Error(translate("Missing the image output path"));
  if (needsAudio && !options.audioPath) throw new Error("缺少音轨输出路径");
  if (needsVideo && !options.videoPath) throw new Error("缺少视频输出路径");
  const outputs = [needsAudio ? options.audioPath : undefined, needsVideo ? options.videoPath : undefined, lastFrame ? options.imagePath : undefined].filter((path): path is string => !!path).map(normalizePath);
  if (outputs.includes(sourcePath) || new Set(outputs).size !== outputs.length) throw new Error("输出文件不能覆盖原视频或彼此覆盖");

  const media = await probeMedia(ffmpeg, source, signal);
  const video = media.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video) throw new Error("文件不包含视频画面");
  const duration = Number(media.format.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取有效的视频时长");
  if (needsAudio && !media.streams.some(stream => stream.codec_type === "audio")) throw new Error("该视频没有音轨");
  if (options.action === "trim" && (!Number.isFinite(options.start) || !Number.isFinite(options.end)
    || options.start! < 0 || options.end! <= options.start! || options.end! > duration)) {
    throw new Error("截取范围须满足 0 ≤ 开始时间 < 结束时间 ≤ 视频时长");
  }

  const command = ffmpeg(source);
  if (lastFrame) {
    // The last frame becomes the first frame of the next shot, to continue the same take: decode the final second and
    // keep overwriting one PNG so the file ends as the very last frame.
    command.inputOptions("-sseof", "-1").output(options.imagePath!).format("image2")
      .outputOptions("-map", `0:${video.index}`, "-update", "1");
    await runCommand(command, signal);
    const image = (await probeMedia(ffmpeg, options.imagePath!, signal)).streams.find(stream => stream.codec_type === "video");
    if (!image?.width || !image.height) throw new Error(translate("The extracted frame is not a valid image"));
    return { duration, width: image.width, height: image.height, sourceFps: 0 };
  }
  if (options.action === "trim") command.seekInput(options.start!);
  if (needsAudio) {
    command.output(options.audioPath!).noVideo().audioCodec("aac").audioBitrate(192).format("ipod")
      .outputOptions("-map", "0:a:0", "-movflags", "+faststart");
  }
  if (needsVideo) {
    // ACT: Re-encode to H.264 for frame-accurate cuts and player compatibility;
    // odd dimensions are only padded to even, never stretched.
    // Every edit lands on one 30 fps timeline; 24 fps sources then repeat one frame in five, which is expected, not stutter.
    command.output(options.videoPath!).videoCodec("libx264").format("mp4")
      .videoFilters("pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=30")
      .outputOptions("-map", `0:${video.index}`, "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (options.action === "separate") command.noAudio();
    else {
      if (options.action === "trim") command.duration(options.end! - options.start!);
      command.audioCodec("aac").audioBitrate(192).outputOptions("-map", "0:a:0?");
    }
  }
  await runCommand(command, signal);
  const result = await probeMedia(ffmpeg, needsVideo ? options.videoPath! : options.audioPath!, signal);
  const resultVideo = result.streams.find(stream => stream.codec_type === "video");
  const resultDuration = Number(result.format.duration);
  if (!Number.isFinite(resultDuration) || resultDuration <= 0 || (needsVideo && !resultVideo)) throw new Error("生成的媒体文件无效");
  const [numerator, denominator] = String(video.r_frame_rate ?? "0/1").split("/").map(Number);
  const sourceFps = denominator ? numerator! / denominator : 0;
  return { duration: resultDuration, width: resultVideo?.width ?? video.width, height: resultVideo?.height ?? video.height, sourceFps };
}
