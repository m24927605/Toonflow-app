# Audio Node

Places an audio asset on the canvas for listening and supplies it to downstream nodes that accept audio references.

## Inputs and outputs

- Imports a local audio file; a single file must not be empty and must not exceed 100 MB.
- Outputs the current audio asset, which can be connected to nodes that accept audio input.

## Usage

1. Click the upload button and choose an audio file.
2. After the upload finishes, use the player in the node to listen, pause, or seek.
3. Connect the audio output to the nodes that need this asset.
4. To swap the asset, hover over the node and click "Replace audio".
