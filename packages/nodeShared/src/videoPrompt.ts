import type { ShotSpan } from "./shotList";

export type DialogueLine = { speaker?: string; words: string };

// An empty cell marker such as "none", "-" or the Chinese "無" / "无", optionally in brackets.
const noDialogue = /^[\s(（[]*(?:none|n\/a|-+|—+|無|无)?[\s)）\]]*$/i;
// "Speaker: words" with an ASCII or full-width colon; the words may sit in quotation marks or corner brackets.
const speakerLine = /^\s*([^:：「"“]{1,20}?)\s*[:：]\s*(.+)$/;
const quoted = /^[「『"“](.*)[」』"”]$/;

/** The lines of a shot list's dialogue cell, one per speaker turn; an empty marker yields none. */
export function parseDialogue(cell = ""): DialogueLine[] {
  return cell.split(/<br\s*\/?>|[;；]/i).flatMap(part => {
    if (noDialogue.test(part)) return [];
    const match = speakerLine.exec(part);
    const words = (match ? match[2]! : part).trim();
    const text = quoted.exec(words)?.[1]?.trim() ?? words;
    return text ? [{ ...match ? { speaker: match[1]!.trim() } : {}, words: text }] : [];
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
 * the text model never retypes, translates or drops a line. Throws when a marker is missing, repeated or unknown.
 */
export function fillDialogue(prompt: string, lines: DialogueLine[]) {
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
export function videoPromptInstructions(span: ShotSpan, scripts: number, video: { duration: number; previs?: boolean; dubbed?: boolean; loras?: { name: string; trigger: string }[] }, ids: Map<string, string>) {
  const shotList = `{{ref ${scripts + 1}}}`;
  const time = `${Number(span.start.toFixed(2))}–${Number(span.end.toFixed(2))} s`;
  const lines = parseDialogue(span.dialogue);
  return [
    scripts
      ? `${Array.from({ length: scripts }, (_, index) => `{{ref ${index + 1}}}`).join(", ")} is the original script and ${shotList} is its shot list. Read both completely before writing.`
      : `${shotList} is the shot list. Read it completely before writing.`,
    `Write the MiniMax H3 video prompt for shot ${span.shot} (${time}) of the shot list: one continuous ${video.duration}-second shot that starts from that shot's keyframe image, called <Picture 1>.`,
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
    `- Then describe in time order what happens over the ${video.duration} seconds, from the row's action, camera and character-state cells and the story around it in the script: each person's movements, expressions and gaze, and the camera, written as natural phrases such as "the camera holds a static shot" or "the camera pushes in with small amplitude at slow speed". Use no cuts or timestamps.`,
    `- The people in frame are exactly those in the row's cast cell${span.cast ? ` (${span.cast})` : ""}. Refer to each by a short visual description that fits the script, such as "the young woman in the pale kimono", never by a name label. If nobody is in frame, describe only the place.`,
    ...(video.loras ?? []).map(lora => `- ${lora.name} has a trained identity: every time ${lora.name} is mentioned, write the word "${lora.trigger}" followed by woman or man as fits, such as "${lora.trigger} woman in the pale kimono", never a pronoun alone; this word makes the video model draw that exact person.`),
    lines.length
      ? [
          "- The shot has these spoken lines, in this order:",
          ...lines.map((line, index) => `  [[LINE ${index + 1}]] spoken by ${line.speaker ? `${line.speaker} (${ids.get(line.speaker)})` : "the person speaking in this shot"}`),
          "  Where each line is spoken, write the speaker's visual description, the speaker ID in brackets and the voice, then \"says:\" and the marker itself, for example: the young woman with a soft, low voice (S1) says: [[LINE 1]]",
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
