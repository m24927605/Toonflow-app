# Video Node

Imports and plays video assets, and makes the video or captured frames available for later production.

## Inputs and outputs

- Imports a local video file; a single file must not be empty and must not exceed 100 MB.
- Outputs the current video asset, which can be connected to nodes that accept video input.
- Captured frames appear on the canvas as new image nodes.

## Usage

1. Click the upload button to choose a video, and use the player to play, pause, seek, or adjust the volume.
2. Connect the video output to the nodes that need a reference video.
3. Click "Capture video frame" and choose the current, first, or last frame; this requires the Image node plugin to be enabled.
4. To swap the video, hover over the node and click "Replace video".
