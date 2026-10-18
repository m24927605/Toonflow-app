import type { ShotSpan } from "./shotList";

export type DialogueLine = { speaker?: string; words: string };

// An empty cell marker, optionally in brackets: "none", "no dialogue", "silence" or "silent", dashes or dots, or the
// Chinese "\u7121" / "\u65e0" (none) alone or with "\u5c0d\u767d" / "\u53f0\u8a5e" (dialogue), or "\u6c89\u9ed8"
// (silence).
const noDialogue = /^[\s(\uff08[]*(?:none|n\/a|no dialogue|silen(?:t|ce)|[-\u2014\u2013\u2026.\u3002]+|[\u7121\u65e0](?:[\u5c0d\u5bf9]\u767d|\u53f0[\u8a5e\u8bcd])?|\u6c89\u9ed8)?[.\u3002]?[\s)\uff09\]]*$/i;
// "Speaker: words" with an ASCII or full-width colon; the words may sit in quotation marks or corner brackets.
const speakerLine = /^\s*([^:：「"“]{1,20}?)\s*[:：]\s*(.*)$/;
const quoted = /^[「『"“](.*)[」』"”]$/;
// A screenplay parenthetical in round or square brackets, ASCII or full-width, such as "(smiles)" or "(silent)": how a
// line is acted, never words anyone says. One pass removes the innermost brackets, so nested ones take several.
// ACT: a turn written wholly in brackets is read as acting, as the shot-list writer puts "(smiles)" there; a spoken inner
// voice in brackets is dropped with it. Telling the two apart would need the writer to mark voice-overs.
const parenthetical = /[(\uff08[\uff3b][^()\uff08\uff09[\]\uff3b\uff3d]*[)\uff09\]\uff3d]/g;

function withoutParentheticals(text: string) {
  for (let previous = ""; previous !== text;) [previous, text] = [text, text.replace(parenthetical, "")];
  return text;
}

/**
 * The lines of a shot list's dialogue cell, one per speaker turn. Parentheticals are dropped, so an empty marker or a
 * turn that holds only one, such as "Ren: (silent)", yields no line: nothing is dubbed, subtitled or lip-synced for it.
 */
export function parseDialogue(cell = ""): DialogueLine[] {
  if (noDialogue.test(cell)) return [];
  // Brackets go before the cell is split into turns, so a semicolon inside one does not split it.
  return withoutParentheticals(cell).split(/<br\s*\/?>|[;；]/i).flatMap(part => {
    if (noDialogue.test(part)) return [];
    const match = speakerLine.exec(part);
    const words = (match ? match[2]! : part).replace(/\s{2,}/g, " ").trim();
    const text = quoted.exec(words)?.[1]?.trim() ?? words;
    return text && !noDialogue.test(text) ? [{ ...match ? { speaker: match[1]!.trim() } : {}, words: text }] : [];
  });
}

/** The language H3 should speak a line in, from its script: kana means Japanese, Hangul Korean, Han only Chinese. */
export function languageOf(words: string) {
  if (/[぀-ヿ]/.test(words)) return "Japanese";
  if (/[가-힯]/.test(words)) return "Korean";
  if (/[一-鿿]/.test(words)) return "Chinese";
  return "English";
}

/** Speaker IDs in order of first appearance over the whole shot list, so a person keeps one ID in every shot. */
export function speakerIds(spans: ShotSpan[]) {
  const ids = new Map<string, string>();
  for (const line of spans.flatMap(span => parseDialogue(span.dialogue))) {
    if (line.speaker && !ids.has(line.speaker)) ids.set(line.speaker, `S${ids.size + 1}`);
  }
  return ids;
}

/**
 * Puts each dialogue line into the written prompt at its [[LINE n]] marker as H3's <d> tag with the exact words, so
 * the text model never retypes, translates or drops a line. Throws when a marker is missing or unknown.
 */
export function fillDialogue(draft: string, lines: DialogueLine[]) {
  // A model that writes a marker twice, such as once in a summary and once where it is spoken, keeps the one after
  // "says:" (or else the first): a line is spoken once, and the other mention reads fine without it.
  let prompt = draft;
  for (const marker of new Set(draft.match(/\[\[LINE \d+\]\]/g))) {
    const pattern = marker.replace(/[[\]]/g, "\\$&");
    const spoken = new RegExp(`says:\\s*${pattern}`).exec(prompt);
    const keep = spoken ? spoken.index + spoken[0].length - marker.length : prompt.indexOf(marker);
    prompt = prompt.replace(new RegExp(pattern, "g"), (match: string, offset: number) => offset === keep ? match : "");
  }
  const markers = [...prompt.matchAll(/\[\[LINE (\d+)\]\]/g)].map(match => Number(match[1]));
  const expected = lines.map((_, index) => index + 1);
  if (markers.length !== expected.length || expected.some(index => !markers.includes(index))) {
    throw new Error(`expected the markers [[LINE ${expected.join("]], [[LINE ")}]] once each, found ${markers.length ? markers.map(index => `[[LINE ${index}]]`).join(", ") : "none"}`);
  }
  return prompt.replace(/\[\[LINE (\d+)\]\]/g, (_, index: string) => {
    const line = lines[Number(index) - 1]!;
    return `<d>[${languageOf(line.words)}] ${line.words}</d>`;
  });
}

/**
 * Instructions for the text model that writes one shot's MiniMax H3 first-frame (I2VA) prompt. They go to the model
 * only and stay in English, because H3 prompts are written in English. The original scripts come first in the
 * references and the shot list last, so `scripts` is their count; dialogue is written as [[LINE n]] markers that
 * fillDialogue replaces with the exact words.
 */
export function videoPromptInstructions(span: ShotSpan, scripts: number, video: { duration: number; previs?: boolean; dubbed?: boolean; loras?: { name: string; trigger: string }[]; keyframe?: string }, ids: Map<string, string>) {
  const shotList = `{{ref ${scripts + 1}}}`;
  const time = `${Number(span.start.toFixed(2))}–${Number(span.end.toFixed(2))} s`;
  const lines = parseDialogue(span.dialogue);
  return [
    scripts
      ? `${Array.from({ length: scripts }, (_, index) => `{{ref ${index + 1}}}`).join(", ")} is the original script and ${shotList} is its shot list. Read both completely before writing.`
      : `${shotList} is the shot list. Read it completely before writing.`,
    `Write the MiniMax H3 video prompt for shot ${span.shot} (${time}) of the shot list: one continuous ${video.duration}-second shot that starts from that shot's keyframe image, called <Picture 1>.`,
    ...video.keyframe ? [`<Picture 1> shows: ${video.keyframe}`] : [],
    ...video.previs ? ["The video is also given <Video 1>, this shot's grey-box previs: plain boxes and cylinders that show where each person stands and moves, their positions relative to each other, the timing and the camera move. It is a blocking guide only."] : [],
    ...video.dubbed && lines.length ? ["The lines are already recorded as <Audio 1>, the shot's complete soundtrack: the speakers lip-sync to it."] : [],
    ...span.row ? [`This is shot ${span.shot}'s row of the shot list${span.header ? ", under its header" : ""}; everything in this shot comes from it:`, ...span.header ? [span.header] : [], span.row] : [],
    "Output exactly this structure and nothing else:",
    "",
    "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.",
    "",
    "integrated_multimodal_description: [Shot 1] ...",
    "",
    "overall_soundscape: ...",
    "",
    "non_diegetic_music: N/A",
    "",
    "Rules:",
    "- integrated_multimodal_description starts with exactly \"[Shot 1] \" followed by the style (live-action, cinematic, unless the script says otherwise) and the first frame: the setting, the light, where each person is and what they wear and hold, as shown in <Picture 1>; say that their appearance, clothing, positions and the set stay unchanged.",
    "- <Picture 1> is the first frame and wins over the shot list: describe the clothes, the set, the light and the time of day only as <Picture 1> shows them, and add no window view, fire, prop or set piece it does not show. When the row's action is already done in <Picture 1> (a jacket already off, a person already seated), start from <Picture 1> and describe only what still happens.",
    `- Then describe in time order what happens over the ${video.duration} seconds, from the row's action, camera and character-state cells and the story around it in the script: each person's movements, expressions and gaze, and the camera, written as natural phrases such as "the camera holds a static shot" or "the camera pushes in with small amplitude at slow speed". Use no cuts or timestamps.`,
    `- The people in frame are exactly those in the row's cast cell${span.cast ? ` (${span.cast})` : ""}. Refer to each by a short visual description of their age, sex and the clothes <Picture 1> shows, never by a name label. If nobody is in frame, describe only the place. Nobody looks into the camera lens unless the row says so: say where each person looks.`,
    ...(video.loras ?? []).map(lora => `- ${lora.name} has a trained identity: every time ${lora.name} is mentioned, write the word "${lora.trigger}" followed by woman or man as fits, then their clothes as <Picture 1> shows them, never a pronoun alone; this word makes the video model draw that exact person.`),
    lines.length
      ? [
          "- The shot has these spoken lines, in this order:",
          ...lines.map((line, index) => `  [[LINE ${index + 1}]] spoken by ${line.speaker ? `${line.speaker} (${ids.get(line.speaker)})` : "the person speaking in this shot"}`),
          "  Where each line is spoken, write that speaker's own visual description (with their trigger word when they have one), their voice, the speaker ID in brackets, then \"says:\" and the marker itself: <the speaker> with <their voice> (S1) says: [[LINE 1]]. The speaker is the person the line is spoken by, never someone else in the scene.",
          "  Write each marker exactly once and never write the words of a line yourself; they are filled in later. No one says anything else.",
        ].join("\n")
      : "- Nobody speaks in this shot: write no dialogue and no speech.",
    "- overall_soundscape: one to three sentences of only the sounds of the scene (ambience, footsteps, objects, fabric, breathing), without dialogue or music; describe the ambience the same way in every shot of the same scene.",
    "- non_diegetic_music is always N/A: no background music, it is added to the finished film later.",
    ...video.dubbed && lines.length ? [
      "- Right after the first-frame line, add this sentence exactly: \"<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the complete final audio track; each speaker says their words in time with <Audio 1>.\"",
    ] : [],
    ...video.previs ? [
      "- Right after the first-frame line, add this sentence exactly: \"<Video 1> is a grey-box previs used only for blocking: follow where each person stands and moves, their relative positions, the timing and the camera move, but take no shapes, materials, colours, set dressing or markings from it; every person and the set look exactly like <Picture 1>.\"",
      "- Describe the movements and the camera in the same order and timing as <Video 1>.",
    ] : [],
    "- Write everything in English.",
  ].join("\n");
}

/**
 * A person a reference-mode clip shows: their name, their LoRA's trigger word if any, and how the previs camera sees
 * them and where they look, such as "seen in profile, looks at Ren, towards the right of the frame".
 */
export type ReferencePerson = { name: string; trigger?: string; gaze?: string };

/**
 * Instructions for the text model that writes one shot's MiniMax H3 prompt in full-reference mode, with no first frame:
 * <Picture 1> to <Picture N> are the people the shot shows, each in the outfit they wear, then the place; <Video 1> is
 * the grey-box previs that fixes the camera, framing and blocking; <Audio 1> is the dubbed track when there is one. The
 * prompt follows H3's six-section reference rewrite (subject_definitions, summary, retention_analysis,
 * detailed_description, overall_soundscape, non_diegetic_music); dialogue is written as [[LINE n]] markers.
 */
export function referenceVideoPromptInstructions(span: ShotSpan, scripts: number, video: { duration: number; dubbed: boolean; people: ReferencePerson[]; place?: string; blocking: string }, ids: Map<string, string>) {
  const shotList = `{{ref ${scripts + 1}}}`;
  const time = `${Number(span.start.toFixed(2))}\u2013${Number(span.end.toFixed(2))} s`;
  const lines = parseDialogue(span.dialogue);
  const placePicture = video.people.length + 1;
  return [
    scripts
      ? `${Array.from({ length: scripts }, (_, index) => `{{ref ${index + 1}}}`).join(", ")} is the original script and ${shotList} is its shot list. Read both completely before writing.`
      : `${shotList} is the shot list. Read it completely before writing.`,
    `Write the MiniMax H3 video prompt for shot ${span.shot} (${time}) of the shot list: one continuous ${video.duration}-second shot, generated from reference images and a blocking video, with no first frame.`,
    ...span.row ? [`This is shot ${span.shot}'s row of the shot list${span.header ? ", under its header" : ""}; everything in this shot comes from it:`, ...span.header ? [span.header] : [], span.row] : [],
    "The references the video model gets:",
    ...video.people.map((person, index) => `- <Picture ${index + 1}> shows ${person.name} in the clothes they wear in this shot.`),
    ...video.place ? [`- <Picture ${placePicture}> shows the place: ${video.place.replace(/\.$/, "")}.`] : [],
    `- <Video 1> is this shot's grey-box previs. It fixes the camera, the framing, where each person stands and moves, and the timing. Its measured opening, for which side of the frame each person is on: ${video.blocking}. Never copy its distances or heights into the prompt.`,
    ...video.dubbed && lines.length ? ["- <Audio 1> is the shot's complete recorded soundtrack; the speakers lip-sync to it."] : [],
    "Output exactly these six sections in this order and nothing else, each starting with its name and a colon:",
    `subject_definitions: one line per person, "<Subject N> is <their trigger word and woman or man if they have one, else a short visual description, with their age; never a name>, whose face, hair and clothes come from <Picture N>." in the same order as the pictures, with nothing more about how they look; ${video.place ? `then the place as the next <Subject>, "from <Picture ${placePicture}>"; ` : ""}then exactly this: "<Video 1> is a grey-box previs used only for blocking: it gives the camera position, angle, framing and move, where each person stands and moves, and the timing; take no shapes, materials or colours from it."` + (video.dubbed && lines.length ? " and then exactly this: \"<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the complete final audio track; each speaker says their words in time with <Audio 1>.\"" : ""),
    `summary: one sentence: a ${video.duration}-second shot of whom, where, doing what, framed and blocked as <Video 1> shows.`,
    "retention_analysis: one sentence: every person keeps the face, hair and clothes of their picture, the place is kept as its picture, and the camera, framing and positions follow <Video 1>.",
    `detailed_description: starts with exactly "[Shot 1] " followed by the style (live-action, cinematic, unless the script says otherwise), the shot size and one camera from the row, the place and its light; then each person as the shot opens, before the row's action: which side of the frame, their posture and what they hold (someone who comes in starts outside the door or in the doorway, someone who stands up starts seated, someone who sits down starts standing beside the seat); then in time order over the ${video.duration} seconds the row's action from its start to its end, its main verbs early and nothing after them that undoes them, with expressions and the camera as natural phrases such as "the camera holds a static shot"; it ends on the state the row's state cell gives. Use no cuts or timestamps. Show the action of the row actually happening, in the right direction (taking a jacket off is not putting it on; coming in is not standing inside), and only movements that are physically possible (a sliding door slides aside; it is not pushed inward). A door, sliding door or window moves only by someone's hand: write who reaches for it, takes hold of its edge or handle and slides, pulls or pushes it, with the door moving as the hand does, as an action of its own; one no one touches stays as it is. Say the camera once: it holds, pushes in, pulls out or follows, never two of these.`,
    `- The people in frame are exactly ${video.people.length ? video.people.map(person => person.name).join(", ") : "no one; describe only the place"}. Refer to each person by their trigger word as listed below, or by a short visual description when they have none, never by a name.`,
    ...video.people.map(person => `- ${person.name}: ${person.trigger ? `every time they are mentioned write "${person.trigger}" followed by woman or man as fits, never a pronoun alone; this word makes the video model draw that exact person. ` : ""}${person.gaze ? `In <Video 1>, ${person.name} is ${person.gaze}: write this view and where their eyes go, with the side of the frame and anyone they look at written as you refer to them, never by name, when they first appear and again where the shot ends; in between, the row's action leads their eyes (someone who smells a cup looks down at it).` : ""}`),
    "- Nobody looks into the camera lens unless the row says so. Every time you say where someone looks, give the person or thing and the side of the frame it is on, such as \"looks at her, towards the left of the frame\" or \"looks off the right edge of the frame\"; never write that someone looks forward, ahead, out, at the camera or at the viewer, and never write the word lens. Someone out of frame is never named or described: they are \"someone off the left (or right) edge of the frame\".",
    lines.length
      ? [
          "- The shot has these spoken lines, in this order:",
          ...lines.map((line, index) => `  [[LINE ${index + 1}]] spoken by ${line.speaker ? `${line.speaker} (${ids.get(line.speaker)})` : "the person speaking in this shot"}`),
          "  Where each line is spoken, write the speaker by their trigger word followed by woman or man when they have one, otherwise by a short visual description, never by name, then their voice, the speaker ID in brackets, then \"says:\" and the marker itself: <the speaker> with <their voice> (S1) says: [[LINE 1]]. The speaker is the person the line is spoken by, never someone else in the scene.",
          "  Write each marker exactly once and never write the words of a line yourself; they are filled in later. No one says anything else.",
        ].join("\n")
      : "- Nobody speaks in this shot: write no dialogue and no speech.",
    "overall_soundscape: one to three sentences of only the sounds of the scene (ambience, footsteps, objects, fabric, breathing), without dialogue or music; describe the ambience the same way in every shot of the same scene.",
    "non_diegetic_music: always N/A; music is added to the finished film later.",
    "Never describe anyone's face, hair, body or clothes in words anywhere in the prompt: their picture shows them, and words that differ from it win over it.",
    "Write everything in English.",
  ].join("\n");
}
