# Train LoRA

Trains a LoRA on Colab L4s through the Colab CLI and saves it in the workspace's `loras/` folder with a record of its name, kind, model and trigger word. Generation nodes list these in their LoRA menu.

## What it learns

Pick what the LoRA learns, the model it is for, and a name, then connect the material. **Video and image** (the default for looks) trains one LoRA for each at the same time from the same material, with generated variants made once; motion and voice train for video, sliders for images:

| Kind | Material | Model |
|---|---|---|
| Character | one or more images of one person; fewer than 12 are topped up with Qwen-Image variants of the first in other clothes and places, so it learns only the person | MiniMax H3 or Qwen-Image |
| Scene | one or more images of one place; fewer than 12 are topped up with variants of the first from the same side, in other light and slightly closer or shifted, since views it does not show would be invented | MiniMax H3 or Qwen-Image |
| Costume | at least 4 images of the outfit, worn by anyone | MiniMax H3 or Qwen-Image |
| Style | at least 4 images in the look, of varied subjects | MiniMax H3 or Qwen-Image |
| Motion | at least 4 video clips of the movement; each is cropped to multiples of 32, set to 24 fps and cut to at most about 5 s | MiniMax H3 |
| Voice | at least 4 recordings of one voice, each at most about 5 s (they are padded with silence to H3's fixed lengths); the text of the node that made each recording becomes its caption | MiniMax H3 |
| Slider | none: a base prompt and the words its +1 and -1 ends add, such as "laughing" and "expressionless" | MiniMax H3 or Qwen-Image |

The job writes every caption with Qwen3-VL-4B, leaving out exactly what the LoRA learns (the face for a character, the room for a scene, the clothing for a costume, the look for a style, the movement for a motion), so that one thing binds to a random trigger word; it also crops faces into close-ups for characters. Training follows Fizgig's documented recipes (MiniMax H3: rank 8, 50 epochs, identity blocks 20-49, motion on blocks 6-49; Qwen-Image 2.1: the Fast preset, or the Style preset for styles; sliders from prompts).

Training takes about 30–60 minutes and roughly 0.5–1.5 compute units per model (a voice set of 40 recordings took about 80 minutes). It keeps going when the page closes or the node is removed, and only the Cancel button stops it; a second training of the same name and kind is refused while one runs. When Colab has no free GPU because other jobs hold it, or answers that it is short of machines, the job waits for one for up to an hour. Training runs in the background on the Colab machine, so it survives this computer losing its network for up to 30 minutes; every Colab machine Toonflow starts also releases itself after 45 minutes idle without hearing from Toonflow, so an offline, sleeping or crashed computer cannot leave a GPU billing. The node shows the trained LoRA's name, kind, model and trigger word.

## Licences

MiniMax H3 is under the MiniMax H3 Community License: use, modification and LoRAs are licensed only outside the European Union, the United Kingdom, South Korea and the United States, and a commercial product must show "MiniMax H3" in its interface. Qwen-Image 2.1 is under the Qwen Research License: non-commercial use only without a commercial licence from the Qwen team.
