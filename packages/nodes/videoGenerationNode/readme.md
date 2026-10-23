# Video Generation Node

Generates video from a prompt and reference assets, supporting the text-to-video, single-image, first/last-frame, mixed reference, or video extension modes offered by the selected model.

## Inputs and outputs

- Inputs accept text, images, video, and audio; which combinations actually work depends on the model and generation mode.
- Outputs the generated video; the player can also capture the current, first, or last frame as an image node.
- With Sulphur 2, the LoRA menu under the prompt lists the workspace's LTX LoRAs (up to 4; sliders get a strength from -4 to 4), and the LoRAs of the shot's cast are preset by "Prepare videos" and "Build shot nodes". They load on the model at their strength, and any trigger word missing from the prompt is added at its start. LoRAs stay attached when another model is selected but load only with Sulphur 2. The AI agent reads them in the `getConfig` tool (`loras.available` and `loras.attached`) and sets them with `setLoras`.
- Sulphur 2 takes no reference images. In the first/last frame modes connected images are pinned as frames; in the video control mode the one connected video, such as a shot's previs depth video, drives the camera and movement while connected images are the first and last frames, in order. One connected audio clip, such as a dubbed line, is locked as the clip's soundtrack and the picture is lip-synced to it; keep "Generate audio" on. Generating with a connected **Previs** depth video skips the question about skipping previs.

## Usage

1. Select the node and choose a video model; if there is none, add a video model in Settings first.
2. Describe the action, camera movement, and sound, connect reference assets as needed, and adjust their reference order.
3. Open the generation settings and choose the mode, duration, resolution, and aspect ratio; when the model allows it, toggle "Generate audio".
4. In first/last-frame modes, images are assigned in reference order; in "First frame optional" mode with only one image, that image is used as the last frame.
   In "Extend video" mode, connect exactly one video; the duration is the length added after its end, and connected images keep characters and scenes consistent. Chain nodes to extend further.
5. Click "Generate video", or click "Stop generation" to abort.
6. When it finishes, you can play, seek, and adjust the volume, or download and preview full screen from the toolbar above.

Frame capture requires the Image node plugin to be enabled. Duration and resolution options vary by model, and the provider decides which of the common aspect ratios are actually supported.

Sulphur 2 prompts are plain prose without `{{ref N}}` markers, written like Sulphur's own captions: one English paragraph in the present tense that opens with the style and camera (`In this photorealistic live-action video, the camera ...`), introduces each person, then describes every movement, line and sound in the order it happens, and ends with `There are no watermarks present in the video.` Spoken words go in quotation marks after the speaker, their delivery and language, with the English meaning in brackets when they are not English. The bundled `sulphur-prompt-writing` skill has the full rules.

A video node prepared by a shot list's "Prepare videos" shows its preflight above the prompt: the Gate 1 score and the review's findings, highlighted when it failed. Generating from a failed prompt asks first, and editing the prompt afterwards marks the preflight as out of date.
