# Dubbing Node

Mixes a dubbing track, such as a voice-over from audio generation, into a video and outputs the result as a new video.

## Inputs and outputs

- The video input and the dubbing input each take one connection, from nodes such as video generation and audio generation.
- Outputs the dubbed video as an MP4. The picture is copied without re-encoding, the length matches the input video, and dubbing past the end is cut off. Input files are never changed.

## Usage

1. Connect a video to the video input and an audio clip to the dubbing input.
2. Select the node and set where the dubbing starts, the dubbing volume, and the original audio volume. An original volume of 0% replaces the video's own audio; a lower value keeps it under the dubbing.
3. Click "Compose", or click "Stop" to cancel.
4. Each run writes a new file, so earlier results stay available for undo.

Videos whose codec MP4 cannot hold, such as ProRes, are not supported.
