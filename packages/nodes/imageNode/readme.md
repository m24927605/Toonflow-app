# Image Node

Displays an image on the canvas as a reference for characters, scenes, props, or storyboards.

## Inputs and outputs

- Imports a local image file; a single file must not be empty and must not exceed 100 MB.
- Outputs the current image asset, which can be connected to nodes that accept image input, such as image generation and video generation.

## Role

The role menu at the start of the toolbar says what the image is for in the shot flow of the text node: Keyframe (with its shot number), Character (with the character's name; views sharing a name are one character), Scene (with the place's name; a Qwen-Image scene LoRA of that name loads with the keyframes built from it), or Previs layout (with its shot number). An image without a role is not used by "Build shot nodes". A grid split of a Character image gives every cell the same role and character name.

## Usage

1. Click the upload button and choose an image file.
2. After the upload finishes, the node shows a preview in the image's aspect ratio.
3. Connect the image output to the nodes that need a reference image.
4. With the node selected, use the top toolbar to download, preview, or replace the image.


## LoRA

On an image with the Character or Scene role, **Train LoRA** teaches the AI that person or place, so keyframes and videos keep them the same. One click trains it from every image on the canvas with the same role and name, whatever the outfit; without a name it asks for one first. A character trains twice at once, for videos (Sulphur 2) and keyframes (Qwen-Image); a scene trains for keyframes, since videos start from them. One image is enough: with fewer than 12, variants of the clicked image in other clothes, places and light are generated first, so the LoRA learns only the person or place (click the clearest view, and give more real views the same name to make it better). Each model trains on its own Colab GPU at the same time: Qwen-Image for about 30–60 minutes (roughly 0.5–1.5 compute units), Sulphur 2 for about 45–90 minutes on an A100 (roughly 5–10 units), plus up to about 1 unit for generated variants, and the training keeps going when the page closes. The button reads **Finish LoRA** when only one of a character's two LoRAs exists, and **Retrain LoRA** when both do. The job crops each clear face into an extra close-up and captions every image without what the LoRA learns, so it binds to a random trigger word. The LoRAs and their records are saved in the workspace's `loras/` folder; "Build shot nodes" and "Prepare videos" attach the LoRAs of each shot's cast and scenes. Other kinds of LoRA are trained with the Train LoRA node.

## Outfits

A Character image also takes an outfit, such as kimono or nude. Views of one person share the character name; the outfit tells them apart, so "Build shot nodes" picks one outfit per person per shot and a LoRA learns the person across outfits. A grid split of a Character image passes the name and outfit to every cell.
