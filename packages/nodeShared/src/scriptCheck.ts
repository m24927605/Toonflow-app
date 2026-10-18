import { msg, type MessageDescriptor } from "@toonflow/i18n/vue";
import { castNames, shotSpans } from "./shotList";
import { parseDialogue } from "./videoPrompt";

// Short shots fail cheaply and keep generated motion stable; well-paced AI shorts keep most shots within 8 s.
export const maxShotSeconds = 8;
// Shot sizes that frame a speaker's face large enough to draw: medium close-up ("\u4e2d\u8fd1\u666f"), close-up
// ("\u8fd1\u666f", "\u7279\u5beb"/"\u7279\u5199") or over the shoulder ("\u904e\u80a9"/"\u8fc7\u80a9"). Video
// models draw faces from latent cells about 32 px wide: in a two-person medium shot at 720p a face is about 100 px, three
// cells, and comes out soft; framed as the speaker's medium close-up over the listener's shoulder it measured 137 px, with
// clearly better identity and about 2.4 times the sharpness on the same seed.
const closeSize = /close|over[- ]the[- ]shoulder|\bOTS\b|\u8fd1\u666f|\u7279\u5beb|\u7279\u5199|\u904e\u80a9|\u8fc7\u80a9/i;
// An action that puts someone out of frame on purpose: "off-screen", "out of frame", a voice-over ("V.O.", "O.S."), or
// the Chinese "\u756b\u5916" / "\u753b\u5916" (off-screen), "\u756b\u9762\u5916" / "\u753b\u9762\u5916" (outside
// the frame) and "\u65c1\u767d" (narration).
const offScreen = /off[- ]?screen|out of (?:the )?frame|\bV\.?O\.?(?![\p{L}])|\bO\.?S\.?(?![\p{L}])|voice[- ]?over|[\u756b\u753b](?:\u9762)?\u5916|\u65c1\u767d/iu;
// Whether an action names someone: a name in Latin letters as a whole word, so "Ann" is not found in "Anna"; any other
// name as written, since Chinese and Japanese have no spaces between words.
const names = (action: string, name: string) => /^[\p{Script=Latin}\d\s'.-]+$/u.test(name)
  ? new RegExp(`(?<![\\p{L}\\d])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "u").test(action)
  : action.includes(name);

export type ScriptShot = { line: number; start?: number; duration: number };
export type ScriptCheck = { shots: ScriptShot[]; total: number; median: number; issues: MessageDescriptor[] };

// A time is seconds ("4.25", "4s", "4 sec", "4\u79d2") or a clock time ("0:04", "01:02.5"), optionally in bold.
const time = String.raw`\**\s*(\d+(?::\d{1,2})?(?:\.\d+)?)\s*(?:s|sec|secs|seconds|\u79d2)?\s*\**`;
// A table cell holding a time range such as "4.25–8", "0s-4s", "0:00–0:04" or "**22.93**-28.4".
const rangeCell = new RegExp(String.raw`\|\s*${time}\s*(?:[–—~-]|to)\s*${time}\s*(?=\|)`, "i");
// A shot-list line such as "Shot_001 | INT, bedroom | close-up | 3s | ...".
const shotLine = /^\s*\|?\s*Shot_\d+\b.*?\|\s*(\d+(?:\.\d+)?)\s*s\s*\|/i;

function toSeconds(value: string) {
  return value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * Reads the shot list of a script and checks its timing. Shots come from table rows with a time range cell, or
 * from "Shot_NNN | ... | 3s | ..." lines; `target` is the intended total length in seconds.
 */
export function checkScript(markdown: string, target?: number): ScriptCheck {
  const shots: ScriptShot[] = [];
  markdown.split("\n").forEach((text, index) => {
    // The first cell of a table row that holds a time range marks a shot, wherever the time column sits.
    const range = text.trimStart().startsWith("|") ? rangeCell.exec(text) : null;
    if (range) {
      const start = toSeconds(range[1]!);
      shots.push({ line: index + 1, start, duration: toSeconds(range[2]!) - start });
      return;
    }
    const shot = shotLine.exec(text);
    if (shot) shots.push({ line: index + 1, duration: Number(shot[1]) });
  });
  const issues: MessageDescriptor[] = [];
  if (!shots.length) {
    issues.push(msg`No shot list found: write shots as Markdown table rows with a time range cell (0–3.5, 0s–4s or 0:00–0:04) or as Shot_001 | scene | shot size | 3s | action lines`);
    return { shots, total: 0, median: 0, issues };
  }
  for (const [index, shot] of shots.entries()) {
    if (shot.duration <= 0) issues.push(msg`Line ${shot.line}: the shot has no length`);
    else if (shot.duration > maxShotSeconds + 1e-6) issues.push(msg`Line ${shot.line}: shot runs ${shot.duration.toFixed(2)} s, over ${maxShotSeconds} s; split it into shorter shots`);
    const previous = shots[index - 1];
    if (shot.start === undefined || previous?.start === undefined) continue;
    const gap = shot.start - (previous.start + previous.duration);
    if (gap > 0.05) issues.push(msg`Line ${shot.line}: ${gap.toFixed(2)} s gap after the previous shot`);
    else if (gap < -0.05) issues.push(msg`Line ${shot.line}: overlaps the previous shot by ${(-gap).toFixed(2)} s`);
  }
  const lengths = shots.map(shot => shot.duration).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)]!;
  const timed = shots.filter(shot => shot.start !== undefined);
  const total = timed.length === shots.length
    ? Math.max(...shots.map(shot => shot.start! + shot.duration)) - Math.min(...shots.map(shot => shot.start!))
    : lengths.reduce((sum, value) => sum + value, 0);
  if (median > 5) issues.push(msg`Median shot length is ${median.toFixed(2)} s; most shots of a well-paced short run 3–4 s`);
  const spans = shotSpans(shots, markdown);
  // A line is spoken by a face the viewer must read, which a medium shot or wider leaves too small to draw.
  for (const span of spans) {
    if (!parseDialogue(span.dialogue).length || !span.size || closeSize.test(span.size)) continue;
    issues.push(msg`Shot ${span.shot} has a line in a ${span.size}, where the speaker's face is too small to draw: frame the speaker in a medium close-up or closer, alone or over the listener's shoulder, or move the line to a shot that is`);
  }
  // The video model draws only the people of the cast: someone the action names but the cast leaves out, such as the
  // man whose drinking she watches over his shoulder, is drawn as a stranger or as a copy of someone else.
  // ACT: names are the ones some cast cell uses, found in the action as words; an action that only mentions someone out
  // of frame must say so ("off-screen"). A Chinese name inside a longer word, or a group such as "crowd", can still
  // match: a false issue costs one rewrite of the shot list.
  const people = [...new Set(spans.flatMap(span => castNames(span)))];
  for (const span of spans) {
    if (!span.action || offScreen.test(span.action)) continue;
    const cast = castNames(span);
    const missing = people.filter(name => names(span.action!, name) && !cast.includes(name));
    if (missing.length) issues.push(msg`Shot ${span.shot}'s action names ${missing.join(", ")}, who is not in its cast: list everyone the shot shows in Cast, the listener of an over-the-shoulder shot included, or say in the action that they are off-screen`);
  }
  if (target !== undefined && Math.abs(total - target) > Math.max(1, target * 0.05)) issues.push(msg`Total length is ${total.toFixed(2)} s, but the target is ${target} s`);
  return { shots, total, median, issues };
}
