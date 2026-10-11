// Short shots fail cheaply and keep generated motion stable; well-paced AI shorts keep most shots within 8 s.
export const maxShotSeconds = 8;

export type ScriptShot = { line: number; start?: number; duration: number };
export type ScriptCheck = { shots: ScriptShot[]; total: number; median: number; issues: string[] };

const seconds = String.raw`\**\s*(\d+(?:\.\d+)?)\s*\**`;
// A table row whose first cell is a time range such as "4.25–8" or "**22.93**-28.4".
const rangeRow = new RegExp(String.raw`^\|\s*${seconds}\s*[–—-]\s*${seconds}\s*\|`);
// A shot-list line such as "Shot_001 | INT, bedroom | close-up | 3s | ...".
const shotLine = /^\s*\|?\s*Shot_\d+\b.*?\|\s*(\d+(?:\.\d+)?)\s*s\s*\|/i;

/**
 * Reads the shot list of a script and checks its timing. Shots come from table rows starting with a time range, or
 * from "Shot_NNN | ... | 3s | ..." lines; `target` is the intended total length in seconds.
 */
export function checkScript(markdown: string, target?: number): ScriptCheck {
  const shots: ScriptShot[] = [];
  markdown.split("\n").forEach((text, index) => {
    const range = rangeRow.exec(text);
    if (range) {
      const start = Number(range[1]);
      shots.push({ line: index + 1, start, duration: Number(range[2]) - start });
      return;
    }
    const shot = shotLine.exec(text);
    if (shot) shots.push({ line: index + 1, duration: Number(shot[1]) });
  });
  const issues: string[] = [];
  if (!shots.length) {
    issues.push("No shot list found: write shots as table rows starting with a time range (0–3.5) or as Shot_001 | scene | shot size | 3s | action lines");
    return { shots, total: 0, median: 0, issues };
  }
  for (const [index, shot] of shots.entries()) {
    if (shot.duration <= 0) issues.push(`Line ${shot.line}: the shot has no length`);
    else if (shot.duration > maxShotSeconds + 1e-6) issues.push(`Line ${shot.line}: shot runs ${shot.duration.toFixed(2)} s, over ${maxShotSeconds} s; split it into shorter shots`);
    const previous = shots[index - 1];
    if (shot.start === undefined || previous?.start === undefined) continue;
    const gap = shot.start - (previous.start + previous.duration);
    if (Math.abs(gap) > 0.05) issues.push(`Line ${shot.line}: ${gap > 0 ? `${gap.toFixed(2)} s gap after` : `overlaps by ${(-gap).toFixed(2)} s with`} the previous shot`);
  }
  const lengths = shots.map(shot => shot.duration).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)]!;
  const timed = shots.filter(shot => shot.start !== undefined);
  const total = timed.length === shots.length
    ? Math.max(...shots.map(shot => shot.start! + shot.duration)) - Math.min(...shots.map(shot => shot.start!))
    : lengths.reduce((sum, value) => sum + value, 0);
  if (median > 5) issues.push(`Median shot length is ${median.toFixed(2)} s; most shots of a well-paced short run 3–4 s`);
  if (target !== undefined && Math.abs(total - target) > Math.max(1, target * 0.05)) issues.push(`Total length is ${total.toFixed(2)} s, but the target is ${target} s`);
  return { shots, total, median, issues };
}
