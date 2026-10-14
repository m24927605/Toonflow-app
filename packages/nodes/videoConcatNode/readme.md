# Join Videos Node

Joins several videos end to end into one video, for example shots 1 to 3 into a first part, shots 4 to 6 into a second part, and then the two parts into one film.

## Inputs and outputs

- Input: any number of videos, such as video generation nodes, video nodes or other Join videos nodes.
- Output: the joined MP4, which can be connected to nodes that accept video input, including another Join videos node.

## Usage

1. Connect the videos to the node's input.
2. Select the node: the list below shows the videos in the order they will be joined, which is the order they were connected. Drag a video, or press Alt+Left/Right on it, to move it.
3. Click "Join". The result plays in the node and can be downloaded; joining again writes a new file and keeps the earlier ones in `assets/<node id>/`. Joining can be cancelled while it runs.

Every video must have content first; a video that is not generated yet is named in the error. At least two videos are needed.

## Format

The result is H.264 video with AAC audio at the frame rate and frame size of the first video (30 fps when its rate is unknown), so 24 fps clips such as MiniMax H3's keep every frame without repeats. Videos of another size or aspect ratio are scaled to fit and padded with black bars, never stretched; a video without sound gets silence of the same length, so picture and sound stay in sync at every cut. "Smooth cuts" (on by default) fades each clip's sound in and out over 50 ms, which removes the click a hard cut makes in the sound; clip lengths and sync do not change. Otherwise sound is joined as it is: generated clips each bring their own ambience and music, so generate clips without background music and lay one continuous music or ambience track over the joined film with the Add soundtrack node.

Joining uses the FFmpeg configured in Settings → Plugins → FFmpeg.
