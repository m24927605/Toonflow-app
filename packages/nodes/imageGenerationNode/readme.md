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
