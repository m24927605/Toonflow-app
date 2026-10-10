# Audio Generation Node

Generates audio from a prompt, text, and an optional reference image or audio clip. The model list comes from the media model settings and shows audio models only.

## Usage

1. Select the node, choose an audio model, and enter the text or a description of the sound you want.
2. Connect reference nodes as needed. Any number of text references can be connected; images and audio are mutually exclusive, with at most one of them connected in total.
3. Open the generation settings and choose Chinese or English, the sample rate, and the output format; the provider validates what is actually supported.
4. Click generate, or click stop to abort; a failure or cancellation keeps the existing output.
5. After generation you can play, download, trim, change the speed of, or replace the audio, just like in a regular audio node.

Trimming and speed changes create a new regular audio node to the right and require the Audio node plugin (`音频`) to be enabled. Formats the browser cannot play, such as PCM, can still be downloaded.
