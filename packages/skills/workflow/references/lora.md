# LoRA

Use this file whenever the workspace has trained LoRAs or the user wants people, places, costumes or a look to stay the same across many shots. A LoRA is a small add-on trained on Colab from the project's own images; it keeps **what something looks like** in every generation. It does not decide composition, where people stand, or the state carried from shot to shot: keyframes and previs still do that. Only two model families load LoRAs: **Sulphur 2** video (LTX-2.3, family `ltx`) and **Qwen-Image** images (family `qwen`). Seedance and the other cloud models load none, so for them this file only applies to their keyframes made with Qwen-Image.

LoRA work belongs to the asset stage and the execution layer. It never rewrites a finalized prompt's segmentation, blocking, performance, camera or continuity; the node adds trigger words on its own.

## Find what exists

- Trained LoRAs live in the workspace's `loras/` folder, one `<trigger>.safetensors` with a `<trigger>.json` record (`name`, `kind`, `family`, `trigger`). A character LoRA is named after the person, a scene LoRA after the place.
- On a generation node, `node:getConfig` returns `loras.available` (trained LoRAs the node's current model loads) and `loras.attached`. Select the model with `node:setConfig` first; the list is empty for models that load no LoRAs.

## Decide what to train

Check this as soon as the cast and places are known, and guide the user even if they did not ask: many users do not know what a LoRA is. Explain in one plain sentence ("it teaches the AI this face so every shot keeps it"), then tell them exactly what to click. Training spends the user's Colab compute units and you have no tool to start it, so the user starts it:

- **Character or place:** give the image the Character or Scene role and its name, then click **Train LoRA** on its clearest image. One click trains a character for both videos and keyframes and a place for keyframes; one image is enough, missing views are generated first. It takes about 30–60 minutes, keeps going if the page closes, and the button then reads **Retrain LoRA** (or **Finish LoRA** when one of a character's two LoRAs is missing).
- **Other kinds:** a **Train LoRA** node with the material connected.

Build keyframe and video nodes after the LoRAs finish, so the new nodes load them; the **Build shot nodes** dialog shows which people and places still lack one. Work that does not need them (script, shot list, previs) goes on meanwhile.

| Kind | When it pays off | What it is trained from |
|---|---|---|
| Character | A person appears in several shots, especially with head turns or changing angles | Images with the Character role and the same character name, ideally in different outfits, backgrounds and framings; under 12 images, variants in other clothes and places are generated. Trains `qwen` for keyframes and `ltx` for videos together |
| Scene | A place recurs across shots | Images with the Scene role and the same scene name; the LoRA takes that name. It learns the look (materials, light, furnishing), not the exact layout, so keyframes still fix the room |
| Costume | A signature outfit worn by several people or in many shots | Images of the outfit on different people |
| Style | A consistent film look across the project | Varied subjects in that look |
| Slider | Dialing one quality up or down, such as expression intensity | A base prompt and its two ends; use strength between −1 and 1, beyond that it changes identity |
| Motion | A movement the video model cannot make from text alone | Short clips of that movement. Try the text-only prompt first: common actions such as rising from seiza need no LoRA |

Voice LoRAs are not needed when lines are dubbed with TTS and the dubbed track is locked as the clip's soundtrack.

## Check before relying on one

After a LoRA is trained, ask the user to judge one test generation with it against one without it, same prompt and first frame: identity after a head turn, clothing and background not carried over from the training images. A LoRA that only matches the text-only result is not worth attaching.

## Attach

- **Keyframes (Qwen-Image image nodes):** the `qwen` character LoRAs of the people in the shot and the `qwen` scene LoRA of its place.
- **Videos (Sulphur 2 video nodes):** the `ltx` character LoRAs of the people in the shot.
- **Build shot nodes** on a shot list attaches these by itself when the character and scene names on the role-tagged images match the LoRA names. For other nodes, call `node:setLoras` with paths from `loras.available`; an empty list removes them.
- A generation loads at most 4 LoRAs. In a crowded shot, keep the people's LoRAs and drop the scene LoRA.
- Attach a style or costume LoRA only where the user chose it, and keep the same set across the shots of one sequence.

## Write prompts with LoRAs

- The node adds each attached LoRA's trigger word to the prompt when generating; do not paste trigger words into finalized prompts by hand.
- Keep the keyframe's framing consistent with the video prompt. A character LoRA trained mostly on close-ups pulls the video toward a close-up, so describe the first frame's framing in the prompt as well.
- A LoRA does not know a new outfit, an injury or anything else that was not in its training images: the first frame and the prompt carry those.

## Record

In each generation attempt, record the attached LoRAs (name, trigger, strength) with the other effective parameters, as in [State and Delivery](stateAndDelivery.md). Retraining makes a new trigger word, so an older adopted clip keeps pointing at the LoRA it was made with.
