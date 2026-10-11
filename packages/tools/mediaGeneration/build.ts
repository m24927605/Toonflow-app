import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "mediaGeneration",
  displayName: "Media Generation",
  description: "Lists the configured media models and generates images, videos or audio into the workspace.",
  author: "Toonflow",
  prompt: `Before generating, use the available listMediaModels to query models; providerId, modelId, mode, aspect ratio, resolution, duration and audio capabilities follow the returned values, and must not be guessed from model names.
Reference images, video, audio and first/last frames use existing workspace-relative paths; confirm the selected model supports the corresponding inputs. An attachment message only provides file information and does not mean the model has seen the image or played the video.
When canvas node tools are available this turn and the user asks to produce within a node, prefer the generation function already registered by that node so the result stays in that node; for standalone asset production, use the media generation tools available this turn.
Generate only the quantity and scope the user asks for, and prefer reusing existing results; after a failure, deal with the cause first to avoid consuming compute repeatedly. Wait for the tool to return the saved file path before delivering; do not fabricate files or use Base64 instead of a link to the output. Note: unless the user explicitly asks the agent to generate, always handle it on the canvas`,
  configRules: [
    { type: "switch", field: "allowImage", title: "Allow AI to generate images", value: true, props: { "aria-label": "Allow AI to generate images" } },
    { type: "switch", field: "allowVideo", title: "Allow AI to generate videos", value: true, props: { "aria-label": "Allow AI to generate videos" } },
    { type: "switch", field: "allowAudio", title: "Allow AI to generate audio", value: true, props: { "aria-label": "Allow AI to generate audio" } },
  ],
}, import.meta.url);
