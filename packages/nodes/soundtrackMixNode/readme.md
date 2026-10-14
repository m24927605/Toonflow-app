# Add Soundtrack Node

Lays continuous music or ambience under a finished video, for example over the film joined from all shots, so the soundtrack does not restart at every cut.

## Inputs and outputs

- Input: exactly one video, plus one or more audio tracks such as music from an audio generation node and an ambience track.
- Output: the video with the mixed sound, which can be connected to nodes that accept video input. The picture is copied without re-encoding.

## Usage

1. Generate the shots without background music, keeping only dialogue and the sounds of the scene, and join them with the Join videos node.
2. Connect the joined video and the audio tracks to this node.
3. Set the track volume (30% by default, which sits under dialogue), the fade-in and fade-out length (1.5 s by default), and whether the tracks are lowered while the video has sound (on by default).
4. Click "Mix". The result plays in the node and can be downloaded; mixing again writes a new file and keeps the earlier ones in `assets/<node id>/`. Mixing can be cancelled while it runs.

Each track repeats until the video ends and is cut at its end, so a track can be shorter or longer than the video; a track made to the video's length avoids an audible loop point. The video's own sound is kept at full level. With lowering on, any sound in the video above about -30 dBFS, such as dialogue, pulls the tracks down by roughly 8 to 13 dB, and they come back about half a second after it stops; quieter ambience does not; a limiter keeps the mix from clipping.

Mixing uses the FFmpeg configured in Settings → Plugins → FFmpeg.
