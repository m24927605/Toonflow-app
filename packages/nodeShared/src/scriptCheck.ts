import { msg, type MessageDescriptor } from "@toonflow/i18n/vue";
import { shotSpans } from "./shotList";

// Short shots fail cheaply and keep generated motion stable; well-paced AI shorts keep most shots within 8 s.
export const maxShotSeconds = 8;
// Shot sizes that frame a speaker's face large enough to draw: medium close-up ("\u4e2d\u8fd1\u666f"), close-up
// ("\u8fd1\u666f", "\u7279\u5beb"/"\u7279\u5199") or over the shoulder ("\u904e\u80a9"/"\u8fc7\u80a9"). Video
// models draw faces from latent cells about 32 px wide: in a two-person medium shot at 720p a face is about 100 px, three
// cells, and comes out soft; framed as the speaker's medium close-up over the listener's shoulder it measured 137 px, with
// clearly better identity and about 2.4 times the sharpness on the same seed.
const closeSize = /close|over[- ]the[- ]shoulder|\bOTS\b|\u8fd1\u666f|\u7279\u5beb|\u7279\u5199|\u904e\u80a9|\u8fc7\u80a9/i;
// A dialogue cell that holds no line: empty, dashes or dots, "none", "no dialogue", "silence", or "\u7121"/"\u65e0"
// (none) with or without "\u5c0d\u767d"/"\u53f0\u8a5e" (dialogue), or "\u6c89\u9ed8" (silence).
const noLine = /^[\s\u3000]*[(\uff08]?\s*(?:none|n\/a|no dialogue|silen(?:t|ce)|[-\u2014\u2013\u2026.]+|[\u7121\u65e0](?:[\u5c0d\u5bf9]\u767d|\u53f0[\u8a5e\u8bcd])?|\u6c89\u9ed8)?\s*[.\u3002]?\s*[)\uff09]?[\s\u3000]*$/i;

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
  // A line is spoken by a face the viewer must read, which a medium shot or wider leaves too small to draw.
  for (const span of shotSpans(shots, markdown)) {
    if (!span.dialogue || noLine.test(span.dialogue) || !span.size || closeSize.test(span.size)) continue;
    issues.push(msg`Shot ${span.shot} has a line in a ${span.size}, where the speaker's face is too small to draw: frame the speaker in a medium close-up or closer, alone or over the listener's shoulder, or move the line to a shot that is`);
  }
  if (target !== undefined && Math.abs(total - target) > Math.max(1, target * 0.05)) issues.push(msg`Total length is ${total.toFixed(2)} s, but the target is ${target} s`);
  return { shots, total, median, issues };
}
