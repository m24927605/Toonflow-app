# Video Generation Node

Generates video from a prompt and reference assets, supporting the text-to-video, single-image, first/last-frame, or mixed reference modes offered by the selected model.

## Inputs and outputs

- Inputs accept text, images, video, and audio; which combinations actually work depends on the model and generation mode.
- Outputs the generated video; the player can also capture the current, first, or last frame as an image node.

## Usage

1. Select the node and choose a video model; if there is none, add a video model in Settings first.
2. Describe the action, camera movement, and sound, connect reference assets as needed, and adjust their reference order.
3. Open the generation settings and choose the mode, duration, resolution, and aspect ratio; when the model allows it, toggle "Generate audio".
4. In first/last-frame modes, images are assigned in reference order; in "First frame optional" mode with only one image, that image is used as the last frame.
5. Click "Generate video", or click "Stop generation" to abort.
6. When it finishes, you can play, seek, and adjust the volume, or download and preview full screen from the toolbar above.

Frame capture requires the Image node plugin (`图片`) to be enabled. Duration and resolution options vary by model, and the provider decides which of the common aspect ratios are actually supported.
