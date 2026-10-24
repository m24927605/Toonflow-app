---
name: sulphur-prompt-writing
description: Write Sulphur 2 (LTX-2.3) video prompts for Toonflow clips in the caption format Sulphur was trained on, one English paragraph that names the style and camera first, then each person, then every movement, line and sound in the order it happens. Use when writing or repairing the prompt of a Sulphur 2 video node or a production clip.
---

# Sulphur 2 Prompt Writing

Sulphur 2 is an uncensored fine-tune of Lightricks LTX-2.3. One prompt, read by a Gemma 3 text encoder, decides
picture and sound together; a clip may also be held to a first frame, a last frame, a structure video (depth, pose or
edges) and a locked soundtrack. Toonflow runs it without a negative prompt, so the prompt alone decides what appears.
It takes no reference images and does little on its own: a movement, change or sound the prompt does not ask for does
not happen.

## Format

Write the prompt the way Sulphur's own captions are written:

- One paragraph of plain English prose in the present tense. No headings, lists, labels, line breaks, Markdown,
  timestamps, shot numbers or cuts.
- As much detail as the shot needs, within 4,000 characters, about the thousand tokens the text encoder was trained
  on: never drop a movement, line or sound to save words, and never pad with words that show nothing.
- The sentences come in this order:
  1. **Style and camera.** Open with `In this <style> video,` and go straight on to the framing and the camera:
     `In this photorealistic live-action video, the camera remains static at a medium two-shot in a dim kitchen.`
     Name the look of the first frame, such as photorealistic live-action, 2D anime or 3D animation. Sulphur's training
     material leans toward 3D animation, so a live-action clip must say so here.
  2. **People.** Introduce each person once, as the frame shows them: name, apparent age and ethnicity, hair,
     clothing, where they are (left, right, foreground, background), posture and what they hold.
     `Lucía, a Spanish woman in her thirties with a black bob and a grey cardigan, sits at the table on the left holding a mug.`
     When a person has a trained LoRA, write the trigger word right after their name there. Afterwards use the name or
     a pronoun, except in a sentence that speaks a line, which calls its speaker by name.
  3. **Action.** Everything that moves, in the order it happens, linked by "then", "as" and "while": which body part
     moves, which way, how fast and where it stops. One main event per clip, ending on the state the clip ends in.
     Speech and sounds are written into the action at the moment they happen, never gathered at the end.
  4. **Light.** One sentence for the light source, direction and colour, consistent with the first frame, with the
     steady sound of the place.
  5. **Closing.** End with exactly: `There are no watermarks present in the video.`

## Rules

- **First frame.** When the clip starts from a pinned first frame, describe that frame briefly and only as it is: who
  is where, their posture, what they hold, the light. A description that contradicts the picture can make the video
  cut away from it. Spend the words on what changes.
- **Command every change.** Name each movement of heads, eyes, hands, bodies, props and fabric, and each change of
  expression, as a visible action. Show feelings through visible cues (a tightened jaw, eyes dropping to the mug),
  never as inner states ("sad", "remembers").
- **Camera.** Describe only the camera the shot asks for or its structure video implies, relative to the subject:
  static, slow push-in, pulls back, pans left, tilts up, tracks alongside, handheld, over-the-shoulder. Never invent a
  camera move; with none given, the camera remains static.
- **Speech.** Name the speaker in the sentence, then how they say it and the language, then the exact words in
  quotation marks; words that are not English are followed by their English meaning in brackets, without quotation
  marks: `Lucía looks up and asks quietly in Spanish, "¿No vuelves a casa hoy?" (Won't you go home today?).` Keep every line
  exactly as given. When the instructions give the lines as `[[LINE n]]` markers, write the marker where the quoted
  words go and the application fills them in. After a line the speaker closes their lips; people who are not speaking
  keep their lips closed.
- **Sound.** Name concrete sounds where they happen: the cup clicks on the saucer, a sliding door scrapes, rain patters
  on the window. Breaths, moans, sighs and laughter are described in words, not quoted, unless the instructions give
  one as a line: then it is written as speech, with its marker. Mention no music: it is added
  when the film is assembled.
- **Explicit content.** Name nudity and sexual acts plainly, with anatomical terms and the exact movement, position and
  rhythm; euphemisms give vague motion. Everyone shown is an adult.
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
room. Aiko rinvwoman, a Japanese woman in her thirties with a low black bun and a grey knit cardigan, kneels at the left
of a low wooden table with both hands around a white teacup. She lifts the cup slowly, blows across the tea and sets it
down without drinking, the cup clicking softly on the wood, as her eyes move to the paper door on the right. The door
slides open with a dry scrape and Ren, a Japanese man in his thirties with short black hair and a dark wool coat, steps
in and stops just inside the frame, his coat rustling. Aiko looks up at him and says softly in Japanese, "Okaeri"
(Welcome home), then closes her lips and holds his gaze. Warm lamp light falls from the right and leaves the far corner
in shadow, while a kettle hisses faintly in the quiet room. There are no watermarks present in the video.
