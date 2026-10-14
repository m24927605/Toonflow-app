# Video Generation Node

Generates video from a prompt and reference assets, supporting the text-to-video, single-image, first/last-frame, mixed reference, or video extension modes offered by the selected model.

## Inputs and outputs

- Inputs accept text, images, video, and audio; which combinations actually work depends on the model and generation mode.
- Outputs the generated video; the player can also capture the current, first, or last frame as an image node.
- With MiniMax H3, the LoRA menu under the prompt lists the workspace's MiniMax H3 LoRAs (up to 4; sliders get a strength from -4 to 4), and the LoRAs of the shot's cast are preset by "Prepare videos" and "Build shot nodes". They are chained after the Turbo LoRA at their strength, and any trigger word missing from the prompt is added after `[Shot 1]`. LoRAs stay attached when another model is selected but load only with MiniMax H3. The AI agent reads them in the `getConfig` tool (`loras.available` and `loras.attached`) and sets them with `setLoras`.
- The first/last frame modes also take up to 3 reference videos and 3 reference audio clips when the model lists them, such as a shot's previs render after its keyframe, or a dubbed line from audio generation for MiniMax H3 to lip-sync to (name it `fully_copy` in the prompt; see the MiniMax H3 provider notes); generating with a connected **Previs** video skips the question about skipping previs.

## Usage

1. Select the node and choose a video model; if there is none, add a video model in Settings first.
2. Describe the action, camera movement, and sound, connect reference assets as needed, and adjust their reference order.
3. Open the generation settings and choose the mode, duration, resolution, and aspect ratio; when the model allows it, toggle "Generate audio".
4. In first/last-frame modes, images are assigned in reference order; in "First frame optional" mode with only one image, that image is used as the last frame.
   In "Extend video" mode, connect exactly one video; the duration is the length added after its end, and connected images keep characters and scenes consistent. Chain nodes to extend further.
5. Click "Generate video", or click "Stop generation" to abort.
6. When it finishes, you can play, seek, and adjust the volume, or download and preview full screen from the toolbar above.

Frame capture requires the Image node plugin to be enabled. Duration and resolution options vary by model, and the provider decides which of the common aspect ratios are actually supported.

For MiniMax H3, the `{{ref N}}` markers in the prompt are sent as H3's own labels, `<Picture N>` for images, `<Video N>` for videos and `<Audio N>` for audio, numbered per type in connection order; other providers receive the markers unchanged.

A video node prepared by a shot list's "Prepare videos" shows its preflight above the prompt: the Gate 1 score and the review's findings, highlighted when it failed. Generating from a failed prompt asks first, and editing the prompt afterwards marks the preflight as out of date.
