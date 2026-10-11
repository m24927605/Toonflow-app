import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "ffmpeg",
  displayName: "FFmpeg Media Processing",
  description: "Processes workspace audio, video and images with the local FFmpeg, and reads media information with FFprobe.",
  author: "Toonflow",
  prompt: `Before processing, use ffprobe as needed to query the actual media information, then call fluent methods in order through the steps of ffmpeg; operation selects execution or a capability query.
FFmpeg options, filters and file sequences use native syntax; the tool does not rewrite output locations or force a timeout. Choose the output location based on the user's request, and use a new file name unless the user asks to overwrite.
Explicit paths and files in filters, arguments and media lists all use paths inside the current workspace. Wait for execution to succeed before delivering; do not treat a declared output path as a generated file. When FFmpeg is not ready, tell the user to configure it in the plugin settings.`,
  configRules: [],
}, import.meta.url);
