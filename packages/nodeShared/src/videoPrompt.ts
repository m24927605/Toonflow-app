import { castNames, type ShotSpan } from "./shotList";
import sulphurSkill from "@toonflow/skills/sulphurSkill?raw";

export type DialogueLine = { speaker?: string; words: string };

// An empty cell marker, optionally in brackets: "none", "no dialogue", "silence" or "silent", dashes or dots, or the
// Chinese "無" / "无" (none) alone or with "對白" / "台詞" (dialogue), or "沉默"
// (silence).
const noDialogue = /^[\s(（[]*(?:none|n\/a|no dialogue|silen(?:t|ce)|[-—–….。]+|[無无](?:[對对]白|台[詞词])?|沉默)?[.。]?[\s)）\]]*$/i;
// "Speaker: words" with an ASCII or full-width colon; the words may sit in quotation marks or corner brackets.
const speakerLine = /^\s*([^:：「"“]{1,20}?)\s*[:：]\s*(.*)$/;
const quoted = /^[「『"“](.*)[」』"”]$/;
// A screenplay parenthetical in round or square brackets, ASCII or full-width, such as "(smiles)" or "(silent)": how a
// line is acted, never words anyone says. One pass removes the innermost brackets, so nested ones take several.
// ACT: a turn written wholly in brackets is read as acting, as the shot-list writer puts "(smiles)" there; a spoken inner
// voice in brackets is dropped with it. Telling the two apart would need the writer to mark voice-overs.
const parenthetical = /[(（[［][^()（）[\]［］]*[)）\]］]/g;

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

/** Resolves an unlabeled line only when the shot has exactly one visible character. */
export function shotDialogue(span: ShotSpan): DialogueLine[] {
  const cast = castNames(span);
  return parseDialogue(span.dialogue).map(line => {
    const speaker = line.speaker || (cast.length === 1 ? cast[0] : undefined);
    if (!speaker) throw new Error(`Shot ${span.shot}: dialogue needs an explicit speaker`);
    return { ...line, speaker };
  });
}

// Sulphur 2's text encoder was trained on prompts of about a thousand tokens.
export const maxPromptLength = 4000;
const quotes = /["“”「」『』]/;

/** Checks a prompt before the application submits it to Sulphur 2. */
export function validateVideoPrompt(prompt: string) {
  if (!prompt.trim()) throw Object.assign(new Error("The video prompt is empty"), { status: 400 });
  if (/^\s*(?:```|~~~|#{1,6}\s)/m.test(prompt)) throw Object.assign(new Error("Video prompts are plain prose, without Markdown fences or headings"), { status: 400 });
  if (/\{\{ref \d+\}\}|\[\[LINE \d+\]\]/.test(prompt)) throw Object.assign(new Error("The video prompt still contains unfilled markers"), { status: 400 });
  if (prompt.length > maxPromptLength) throw Object.assign(new Error(`The video prompt is ${prompt.length} characters; Sulphur 2 takes at most ${maxPromptLength}`), { status: 400 });
}

// The last sentence of every prompt, as Sulphur's own example prompt ends: it runs without a negative prompt, and its
// training material often carries watermarks.
export const closingSentence = "There are no watermarks present in the video.";

/**
 * Turns a writer's draft into its prompt: one paragraph, each line's exact words in quotation marks in place of its
 * [[LINE n]] marker, and the closing sentence last. The draft must open with the style sentence and hold every marker
 * once, in speaking order, each in a sentence that names its speaker, and no quoted speech of its own. `names` gives the
 * words that name each speaker, such as their name and trigger word.
 */
export function finishPrompt(draft: string, lines: DialogueLine[], names: Map<string, string[]>) {
  const text = draft.trim().replace(/^```[A-Za-z]*\s*\n|\n```$/g, "").replaceAll(closingSentence, "").replace(/\s+/g, " ").trim();
  if (!/^In this [^.]{1,80}? video\b/i.test(text)) throw new Error("Open with \"In this <style> video,\" naming the look, then the framing and camera");
  const markers = [...text.matchAll(/\[\[LINE (\d+)\]\]/g)];
  if (markers.length !== lines.length || markers.some((marker, index) => Number(marker[1]) !== index + 1)) throw new Error(lines.length ? "Write every line once as its [[LINE n]] marker, in speaking order" : "This shot has no dialogue; write no [[LINE n]] markers");
  if (quotes.test(text.replace(/\[\[LINE \d+\]\]/g, ""))) throw new Error("Write no quotation marks or quoted speech; the application quotes each [[LINE n]]");
  // These words render skin as plastic.
  const plastic = text.split(/[.!?;]\s/).find(sentence => /\b(skin|bod(y|ies))\b/i.test(sentence) && /\b(smooth|flawless|glossy|glisten\w*|shiny|sheen)\b/i.test(sentence));
  if (plastic) throw new Error(`Describe skin with natural texture and pores, never smooth, flawless, glossy, glistening or shiny: ${plastic}`);
  for (const [index, marker] of markers.entries()) {
    // The whole sentence around the marker: its speaker may be named after the line, as in "[[LINE 1]], Mika gasps".
    const before = text.slice(0, marker.index).split(/[.!?;]\s/).at(-1) ?? "";
    const after = text.slice(marker.index! + marker[0].length).split(/[.!?;](?:\s|$)/)[0] ?? "";
    const sentence = `${before} ${after}`.toLowerCase();
    const speaker = lines[index]!.speaker;
    if (speaker && !(names.get(speaker) ?? [speaker]).some(name => sentence.includes(name.toLowerCase()))) throw new Error(`Name ${speaker} in the sentence that speaks [[LINE ${index + 1}]], written as ${(names.get(speaker) ?? [speaker]).join(" or ")} exactly, never translated or romanized`);
  }
  return `${text.replace(/\[\[LINE (\d+)\]\]/g, (_, index: string) => `"${lines[Number(index) - 1]!.words}"`)} ${closingSentence}`;
}

export type PromptPerson = { name: string; trigger?: string; look?: string; opening?: string };

/**
 * Instructions for the text model that writes one shot's Sulphur 2 prompt: the prompting rules, the shot, its look
 * (`style`, or the one its first frame shows), who and what its first frame shows, how the previs moves it, and the
 * dialogue as markers the application fills with the original words.
 */
export function videoPromptInstructions(span: ShotSpan, scripts: number, video: { duration: number; style?: string; opening: string; people: PromptPerson[]; place?: string; control: boolean; blocking?: string; note?: string }) {
  if (!video.opening.trim()) throw new Error("A description of the clip's first frame is required");
  const lines = shotDialogue(span);
  return [
    sulphurSkill,
    [
      `Read the complete script in ${scripts ? Array.from({ length: scripts }, (_, index) => `{{ref ${index + 1}}}`).join(", ") : "the supplied context"} and the complete shot list in {{ref ${scripts + 1}}}.`,
      `Write only shot ${span.shot} (${span.start}–${span.end} s of the film) as one continuous ${video.duration}-second clip, without cuts. Output the prompt paragraph only.`,
      ...span.header ? [span.header] : [],
      ...span.row ? [span.row] : [],
      "State is the OPENING state of the shot, not its ending. Develop the row's action from that opening and end in the resulting state. Keep identity, set, lighting and every attribute the action does not explicitly change; allow the movement, wardrobe and prop changes the script requires.",
    ].join("\n"),
    video.style ? `Open with: In this ${video.style} video,` : "Open with \"In this <style> video,\" naming the look the first frame shows, such as photorealistic live-action, 2D anime or 3D animation.",
    `The clip's first frame shows: ${video.opening}`,
    ...video.people.length ? [["The people, each named exactly as written here, never translated or romanized:", ...video.people.map(person => `- ${person.name}${person.trigger ? ` (trained identity, trigger word ${person.trigger}: write it right after the name where ${person.name} first appears)` : ""}${person.look ? `: ${person.look}` : ""}${person.opening ? ` At the opening: ${person.opening}` : ""}`)].join("\n")] : ["Nobody is in this shot: no person, hand or silhouette appears."],
    ...video.place ? [`The place, which the application describes with this sentence; keep the room consistent with it: ${video.place}`] : [],
    "Describe skin as real skin with natural texture, pores and fine lines; never call it smooth, flawless, glossy, glistening or shiny, even where the script does. Sweat is small droplets, not a sheen.",
    ...video.control
      ? [`A grey-box previs drives the camera and where everyone stands and moves, and when; its grey shapes are not the look. Describe the same camera and movement, never a different one.${video.blocking ? ` The previs: ${video.blocking}` : ""}`]
      : video.blocking ? [`Planned blocking: ${video.blocking}`] : [],
    lines.length
      ? [
        "The application inserts the spoken words. Write each line only as its marker, once, in speaking order, inside a sentence that names its speaker, how they say it and the language, such as: Mika asks quietly in Japanese, [[LINE 1]] (Won't you go home today?). That sentence calls the speaker by name, never only by a pronoun, and a cry or moan given as a line is written as a line in the same way. Follow a line that is not in English with its English meaning in brackets, as there. Never write quotation marks or other words anyone says.",
        ...lines.map((line, index) => `- [[LINE ${index + 1}]]: ${line.speaker} says ${JSON.stringify(line.words)}`),
        "Each line is one completed speaking beat; afterwards the speaker's lips close. People who are not speaking keep their lips closed.",
      ].join("\n")
      : "Nobody speaks in this shot: write no dialogue and keep everyone's lips closed.",
    "Mention no music: music is added when the film is assembled.",
    ...video.note ? [video.note] : [],
  ].join("\n\n");
}
