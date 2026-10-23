# Train LoRA

Trains a LoRA on Colab through the Colab CLI and saves it in the workspace's `loras/` folder with a record of its name, kind, model and trigger word. Generation nodes list these in their LoRA menu.

## What it learns

Pick what the LoRA learns, the model it is for, and a name, then connect the material. **Video and image** (the default for looks) trains one LoRA for each at the same time from the same material, with generated variants made once; motion trains for video, sliders for images:

| Kind | Material | Model |
|---|---|---|
| Character | one or more images of one person; fewer than 12 are topped up with Qwen-Image variants of the first in other clothes and places, so it learns only the person | Sulphur 2 or Qwen-Image |
| Scene | one or more images of one place; fewer than 12 are topped up with variants of the first from the same side, in other light and slightly closer or shifted, since views it does not show would be invented | Sulphur 2 or Qwen-Image |
| Costume | at least 4 images of the outfit, worn by anyone | Sulphur 2 or Qwen-Image |
| Style | at least 4 images in the look, of varied subjects | Sulphur 2 or Qwen-Image |
| Motion | at least 4 video clips of the movement; each is set to 24 fps, cropped to multiples of 32 and trained on its first 49 frames (about 2 s) | Sulphur 2 |
| Slider | none: a base prompt and the words its +1 and -1 ends add, such as "laughing" and "expressionless" | Qwen-Image |

The job writes every caption with Qwen3-VL-4B, leaving out exactly what the LoRA learns (the face for a character, the room for a scene, the clothing for a costume, the look for a style, the movement for a motion), so that one thing binds to a random trigger word; it also crops faces into close-ups for characters. Sulphur 2 LoRAs train with Lightricks' ltx-trainer v1.5.0 on the Sulphur 2 dev weights its video model is quantised from: rank 32, AdamW at 1e-4, 1,500 steps, on the video branch only, so the sound is left as it is. Qwen-Image 2.1 LoRAs follow Fizgig's documented recipes (the Fast preset, or the Style preset for styles; sliders from prompts).

Training takes about 30–60 minutes and roughly 0.5–1.5 compute units for Qwen-Image, and about 45–90 minutes and roughly 5–10 units for Sulphur 2 on an A100 (estimates; the first trainings will measure them). It keeps going when the page closes or the node is removed, and only the Cancel button stops it; a second training of the same name and kind is refused while one runs. When Colab has no free GPU because other jobs hold it, or answers that it is short of machines, the job waits for one for up to an hour. Training runs in the background on the Colab machine, so it survives this computer losing its network for up to 30 minutes; every Colab machine Toonflow starts also releases itself after 45 minutes idle without hearing from Toonflow, so an offline, sleeping or crashed computer cannot leave a GPU billing. The node shows the trained LoRA's name, kind, model and trigger word.

## Licences

Sulphur 2 is a fine-tune of LTX-2.3 under the LTX-2 Community License Agreement. Qwen-Image 2.1 is under the Qwen Research License: non-commercial use only without a commercial licence from the Qwen team.
