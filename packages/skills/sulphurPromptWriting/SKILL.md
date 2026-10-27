---
name: sulphur-prompt-writing
description: Write Sulphur 2 (LTX-2.3) video prompts for Toonflow clips in the caption format Sulphur was trained on, one English paragraph that names the style and camera first, then each person, then every movement, line and sound in the order it happens. Use when writing or repairing the prompt of a Sulphur 2 video node or a production clip.
---

# Sulphur 2 Prompt Writing

Sulphur 2 is an uncensored fine-tune of Lightricks LTX-2.3. One prompt, read by a Gemma 3 text encoder, decides
picture and sound together; a clip may also be held to a first frame, a last frame, a structure video (depth, pose or
edges) and a locked soundtrack. Toonflow runs it without a negative prompt, so the prompt alone decides what appears.
It takes no reference images, so a first frame is what fixes who and where; it does little on its own: a movement,
change or sound the prompt does not ask for does not happen.

## Format

Write the prompt the way Sulphur's own captions read. Its bundled prompt enhancer, which reproduces them, describes a
whole clip in plain sentences: the look and framing, who is there in a few words, then what happens and what is heard,
naming sexual acts in blunt anatomical words. LTX-2.3's own image-to-video guidance adds: a clip held to a first frame
must not be described differently from that frame, or the video cuts away from it.

- One paragraph of plain English prose in the present tense. No headings, lists, labels, line breaks, Markdown,
  timestamps, shot numbers or cuts.
- Usually 80 to 200 words, and never past 4,000 characters. Most of the words go to the action; the people and the
  place take a sentence or two. Never drop a movement, line or sound to save words.
- The sentences come in this order:
  1. **Style and camera.** Open with `In this <style> video,` and go straight on to the framing and the camera:
     `In this photorealistic live-action video, the camera remains static at a medium two-shot in a dim kitchen.`
     Name the look of the first frame, such as photorealistic live-action, 2D anime or 3D animation. Sulphur's training
     material leans toward 3D animation, so a live-action clip must say so here.
  2. **People.** One short clause per person: name, where they are, posture, what they wear (or that they are naked)
     and what they hold. `Lucía sits at the table on the left in a grey cardigan, holding a mug.` When a person has a
     trained LoRA, write the trigger word right after their name there. Add age, ethnicity and hair only when the clip
     has no first frame. Never describe faces or skin; a first frame and the LoRA already show them.
  3. **Action.** Everything that moves, in the order it happens, linked by "then", "as" and "while": which body part
     moves, which way, how fast and where it stops. One main event per clip, ending on the state the clip ends in.
     Speech and sounds are written into the action at the moment they happen, never gathered at the end.
  4. **Light.** One short sentence for the light source and its colour, as the first frame shows it, with the steady
     sound of the place.
  5. **Closing.** End with exactly: `There are no watermarks present in the video.`

## Rules

- **First frame.** When the clip starts from a pinned first frame, everything written about the opening must match
  that picture: who is where, their posture and clothes, the light. Write nothing it does not show, and spend the
  words on what changes.
- **Command every change.** Name each movement of heads, eyes, hands, bodies, props and fabric, and each change of
  expression, as a visible action. Describe what is seen and heard, never inner states, moods or intentions ("sad",
  "remembers", "an intimate atmosphere").
- **Camera.** Describe only the camera the shot asks for or its structure video implies, relative to the subject:
  static, slow push-in, pulls back, pans left, tilts up, tracks alongside, handheld, over-the-shoulder. Never invent a
  camera move; with none given, the camera remains static.
- **Speech.** Name the speaker in the sentence, then how they say it and the language, then the exact words in
  quotation marks; words that are not English are followed by their English meaning in brackets, without quotation
  marks: `Lucía looks up and asks quietly in Spanish, "¿No vuelves a casa hoy?" (Won't you go home today?).` Keep every line
  exactly as given. When the instructions give the lines as `[[LINE n]]` markers, write the marker where the quoted
  words go and the application fills them in. Only the speaker of a line moves their lips to speak; nobody else mouths
  words, while breathing, gasps, moans and kisses move mouths freely.
- **Sound.** Name concrete sounds where they happen: the cup clicks on the saucer, a sliding door scrapes, rain patters
  on the window. Breaths, moans, sighs and laughter are described in words, not quoted, unless the instructions give
  one as a line: then it is written as speech, with its marker. Mention no music: it is added
  when the film is assembled.
- **Explicit content.** Name nudity and sexual acts as bluntly as Sulphur's captions do: the genitals by name (penis,
  vagina, pussy, breasts, nipples), what enters what, the position, who moves, how and how fast, and what is visible to
  the camera. Euphemisms give vague motion. Everyone shown is an adult.
- **Plain words.** Literal and concrete: "soft window light from the left", not "breathtaking cinematic lighting". No
  smell, taste or touch, which cannot be filmed.

## Avoid

- Readable text, signs, captions, subtitles, screens with writing, logos and brand names: Sulphur cannot write and
  tends to add stray text.
- More people, props or actions than the shot needs; fast twisting, juggling and other chaotic physics.
- Lighting that contradicts the first frame, or two conflicting light sources.
- Talking about the prompt, the model, the references or these rules.

## Example

In this photorealistic live-action video, the camera holds a static medium shot at seated eye level in a dim tatami
room. Aiko rinvwoman kneels at the left of a low wooden table in a grey knit cardigan, both hands around a white
teacup. She lifts the cup slowly, blows across the tea and sets it
down without drinking, the cup clicking softly on the wood, as her eyes move to the paper door on the right. The door
slides open with a dry scrape and Ren steps in wearing a dark wool coat and stops just inside the frame, his coat
rustling. Aiko looks up at him and says softly in Japanese, "Okaeri"
(Welcome home), then holds his gaze. Warm lamp light falls from the right and leaves the far corner
in shadow, while a kettle hisses faintly in the quiet room. There are no watermarks present in the video.
