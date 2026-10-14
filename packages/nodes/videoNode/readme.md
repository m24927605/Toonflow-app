# Video Node

Imports and plays video assets, and makes the video or captured frames available for later production.

## Inputs and outputs

- Imports a local video file; a single file must not be empty and must not exceed 100 MB.
- Outputs the current video asset, which can be connected to nodes that accept video input.
- Captured frames appear on the canvas as new image nodes.
- The role menu at the start of the toolbar can mark the video as a **Previs** render with its shot number; the Director's Studio marks the colour render of each confirmed shot automatically. "Build shot nodes" and "Prepare videos" connect it to that shot's video node as a blocking reference, after the keyframe, with a prompt that names it a grey-box guide for blocking, relative positions, timing and camera only.

## Usage

1. Click the upload button to choose a video, and use the player to play, pause, seek, or adjust the volume.
2. Connect the video output to the nodes that need a reference video.
3. Click "Capture video frame" and choose the current, first, or last frame; this requires the Image node plugin to be enabled.
4. To swap the video, hover over the node and click "Replace video".

"Last frame" saves the video's final frame as a PNG in a new image node and keeps the video. Connect that image to the next shot's video generation as its first frame to continue the same take (video extension); it suits consecutive shots from the same camera position, while a cut to a new angle starts from its own keyframe.
