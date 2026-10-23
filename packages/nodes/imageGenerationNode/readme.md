# Image Generation Node

Generates images from a prompt and can also use existing images and text as references to create character, scene, or storyboard images.

## Inputs and outputs

- Inputs accept images, text and one character identity; connected text becomes part of the generation request. A character identity, from the character identity node, keeps the same face across images and needs an image model that supports it, such as Higgsfield Soul 2.0 or Soul Cinematic.
- Outputs one generated image, which can be used as a reference for further image or video generation.

## Usage

1. Select the node and choose an image model below; if there is none, add an image model in Settings first.
2. Describe the image you want, connect image or text references as needed, and refer to them in the prompt.
3. Click the aspect ratio and resolution area and pick from the options the current model offers.
4. Click "Generate image"; during generation you can click "Stop generation".
5. When it finishes, view the result in the node; with the node selected, download it or open an enlarged preview from the toolbar above.

Reference assets can be reordered or removed in the input area. Connected nodes must already have content, and after changing the prompt or settings you need to click generate again to produce a new image.

Before sending, the node checks the prompt: on-screen text the model would have to render, and how it names references (no `{{ref N}}` at all, a number past the connected references, a connected reference it never names, or several cells of one grid split, which are usually angles of one character). Generating a single node asks whether to send anyway; generating a canvas selection fails the affected nodes with the reason instead, so the other nodes still run in the same batch.

The role menu at the start of the toolbar says what the image is for in the shot flow: Keyframe (with its shot number), Character (with the character's name; views sharing a name are one character), Scene (with the place's name; a Qwen-Image scene LoRA of that name loads with the keyframes built from it), or Previs layout (with its shot number); without a role the image is not used by "Build shot nodes". On a Keyframe, "Set as master shot" connects its image to every other keyframe with a shot number as their last reference and adds a line asking them to match its lighting, colour, clothing and props while following their own composition. Nodes that already follow a different master are left unchanged, and nodes that already have images need regenerating to apply it.


## LoRA

On an image with the Character or Scene role, **Train LoRA** teaches the AI that person or place, so keyframes and videos keep them the same. One click trains it from every image on the canvas with the same role and name, whatever the outfit; without a name it asks for one first. A character trains twice at once, for videos (Sulphur 2) and keyframes (Qwen-Image); a scene trains for keyframes, since videos start from them. One image is enough: with fewer than 12, variants of the clicked image in other clothes, places and light are generated first, so the LoRA learns only the person or place (click the clearest view, and give more real views the same name to make it better). Each model trains on its own Colab GPU at the same time: Qwen-Image for about 30–60 minutes (roughly 0.5–1.5 compute units), Sulphur 2 for about 45–90 minutes on an A100 (roughly 5–10 units), plus up to about 1 unit for generated variants, and the training keeps going when the page closes. The button reads **Finish LoRA** when only one of a character's two LoRAs exists, and **Retrain LoRA** when both do. The job crops each clear face into an extra close-up and captions every image without what the LoRA learns, so it binds to a random trigger word. The LoRAs and their records are saved in the workspace's `loras/` folder; "Build shot nodes" and "Prepare videos" attach the LoRAs of each shot's cast and scenes. Other kinds of LoRA are trained with the Train LoRA node.

## Outfits

A Character image also takes an outfit, such as kimono or nude. Views of one person share the character name; the outfit tells them apart, so "Build shot nodes" picks one outfit per person per shot and a LoRA learns the person across outfits. A grid split of a Character image passes the name and outfit to every cell.

## LoRA menu

With a Qwen-Image model, the LoRA menu under the prompt lists the workspace's Qwen-Image LoRAs (up to 4; sliders get a strength from -4 to 4). They load with the generation, and any trigger word missing from the prompt is added to it. LoRAs stay attached when another model is selected but load only with Qwen-Image. The AI agent reads them in the `getConfig` tool (`loras.available` and `loras.attached`) and sets them with `setLoras`.
