# Media Generation

Lets the Agent query configured media models, generate images, videos, or audio on request, and save the results to the current workspace.

## How to Use

First add a provider in Settings → Media models, configure its API key and the models you want to use, then open a project.
When you want the Agent to generate a file directly, you can say: "Please generate a warm-toned product poster directly and save it to the workspace."
When you want to produce it inside a node, use it together with the Canvas Operations (`画布操作`) tool so the Agent uses the corresponding node's generation function.

## Features

- Query the image, video, and audio models currently allowed, and the generation options each model supports.
- Generate images from prompts, using reference images, aspect ratio, and size as the model supports.
- Generate videos, using images, videos, audio, first and last frames, and duration, resolution, and sound options as the model supports.
- Generate audio, using reference audio, voice, speed, volume, and output format as the model supports.
- Wait for generation and saving, then return the file location; files are saved to `assets/generated` in the workspace by default, or to an output directory you specify within the workspace.

Reference materials must already exist in the workspace. The features available depend on the selected model, and not every model supports all options.

## Configuration

In Settings → Plugins → Installed, find Media Generation (`媒体生成`) and click "Configuration".
"Allow AI to generate images", "Allow AI to generate videos", and "Allow AI to generate audio" (`允许 AI 生成图片`, `允许 AI 生成视频`, `允许 AI 生成音频`) are all on by default and control which generation types the Agent can call directly.
Provider keys are configured separately in Media models and do not reuse text model keys; these switches do not replace a node's own configuration.
