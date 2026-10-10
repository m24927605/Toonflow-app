# Dubbing Node

Mixes a dubbing track, such as a voice-over from audio generation, into a video and outputs the result as a new video.

## Inputs and outputs

- The video input and the dubbing input each take one connection, from nodes such as video generation and audio generation.
- Outputs the dubbed video as an MP4. The picture is copied without re-encoding, the length matches the input video, and dubbing past the end is cut off. Input files are never changed.

## Usage

1. Connect a video to the video input and an audio clip to the dubbing input.
2. Select the node and set where the dubbing starts, the dubbing volume, and the original audio level while the dubbing plays. The video's own audio is lowered only for the length of the dubbing, easing in and out over 0.25 seconds, and keeps its full volume before and after. At the default 0%, only the dubbing is heard while it plays, which also removes any voice the video model generated in that span; raise it to keep ambience or music under the dubbing.
3. Click "Compose", or click "Stop" to cancel.
4. Each run writes a new file, so earlier results stay available for undo.

Videos whose codec MP4 cannot hold, such as ProRes, are not supported.
