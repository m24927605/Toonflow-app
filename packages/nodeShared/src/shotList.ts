import type { ScriptShot } from "./scriptCheck";

/**
 * Every field is plain text: cells are cleaned of table markup such as <br>, and `row` and `header` are rebuilt from
 * the cleaned cells. `cast`, `state`, `size`, `dialogue` and `action` are the shot's cells in the cast, character-state,
 * shot-size, dialogue and action columns, when it has them;
 * `row` is the shot's whole line and `header` the table's header line, when the shot list is a table.
 */
export type ShotSpan = { shot: number; start: number; end: number; cast?: string; state?: string; size?: string; dialogue?: string; action?: string; row?: string; header?: string };

// A cast column header: "Cast", "Characters", or the Chinese "\u4eba\u7269" (people), "\u89d2\u8272" (characters) or
// "\u51fa\u5834" / "\u51fa\u573a" (on screen).
const castHeader = /cast|characters?|\u4eba\u7269|\u89d2\u8272|\u51fa[\u5834\u573a]/i;
// A character-state column header: "State", "Pose", or the Chinese "\u72c0\u614b" / "\u72b6\u6001" (state) or
// "\u59ff\u614b" / "\u59ff\u6001" (posture). It is checked first, since "\u4eba\u7269\u72c0\u614b" also names people.
const stateHeader = /state|pose|\u72c0\u614b|\u72b6\u6001|\u59ff[\u614b\u6001]/i;
// A shot-size column header: "Shot size", "Size", or the Chinese "\u666f\u5225" / "\u666f\u522b".
const sizeHeader = /size|\u666f[\u5225\u522b]/i;
// A dialogue column header: "Dialogue", "Lines", or the Chinese "\u5c0d\u767d" / "\u5bf9\u767d" (dialogue) or
// "\u53f0\u8a5e" / "\u53f0\u8bcd" (lines).
const dialogueHeader = /dialogue|lines|[\u5c0d\u5bf9]\u767d|\u53f0[\u8a5e\u8bcd]/i;
// An action column header: "Action", or the Chinese "\u52d5\u4f5c" / "\u52a8\u4f5c" (action).
const actionHeader = /action|[\u52d5\u52a8]\u4f5c/i;
// Models break lines inside a table cell with <br>; prompts are plain text, so the parts are joined with a full-width
// semicolon instead, which parseDialogue and the cast split already treat as a separator.
const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
  .map(cell => cell.split(/<br\s*\/?>/i).map(part => part.trim()).filter(Boolean).map((part, index, parts) => index < parts.length - 1 ? part.replace(/[。.]$/, "") : part).join("；"));

/**
 * Shot times in seconds, and each shot's cast, character-state, shot-size, dialogue and action cells when the table has those columns; a shot list
 * without time ranges runs its shots back to back.
 */
export function shotSpans(shots: ScriptShot[], markdown: string): ShotSpan[] {
  const lines = markdown.split("\n");
  // The header is the nearest table row above the first shot that is not a separator row.
  const first = (shots[0]?.line ?? 1) - 1;
  let header: string[] = [];
  for (let index = first - 1; index >= 0 && lines[index]!.trimStart().startsWith("|"); index--) {
    if (!/^[\s|:-]+$/.test(lines[index]!)) header = cells(lines[index]!);
  }
  const stateIndex = header.findIndex(cell => stateHeader.test(cell));
  const castIndex = header.findIndex((cell, index) => index !== stateIndex && castHeader.test(cell));
  const sizeIndex = header.findIndex(cell => sizeHeader.test(cell));
  const dialogueIndex = header.findIndex(cell => dialogueHeader.test(cell));
  const actionIndex = header.findIndex(cell => actionHeader.test(cell));
  let cursor = 0;
  return shots.map((item, index) => {
    const start = item.start ?? cursor;
    cursor = start + item.duration;
    const row = cells(lines[item.line - 1] ?? "");
    // Whole rows are rebuilt from the cleaned cells, so no reader of a span ever sees the table's raw markup.
    const rowText = row.length ? `| ${row.join(" | ")} |` : undefined;
    const cast = castIndex >= 0 ? row[castIndex] : undefined;
    const state = stateIndex >= 0 ? row[stateIndex]?.trim() || undefined : undefined;
    const size = sizeIndex >= 0 ? row[sizeIndex]?.trim() || undefined : undefined;
    const dialogue = dialogueIndex >= 0 ? row[dialogueIndex]?.trim() || undefined : undefined;
    const action = actionIndex >= 0 ? row[actionIndex]?.trim() || undefined : undefined;
    return {
      shot: index + 1, start, end: cursor, ...(rowText ? { row: rowText } : {}), ...(header.length ? { header: `| ${header.join(" | ")} |` } : {}),
      ...(cast === undefined ? {} : { cast }), ...(state === undefined ? {} : { state }), ...(size === undefined ? {} : { size }), ...(dialogue === undefined ? {} : { dialogue }),
      ...(action === undefined ? {} : { action }),
    };
  });
}

/**
 * The template for one shot whose cast is a subset of the characters the template names: absent characters' lines (a
 * line that starts with the name and names a reference) are removed and the remaining {{ref N}} renumbered from the
 * full reference order to the shot's own.
 */
export function templateForCast(template: string, fullOrder: string[], shotOrder: string[], absentNames: string[]) {
  const renumber = new Map(shotOrder.map((id, index) => [fullOrder.indexOf(id) + 1, index + 1]));
  return template.split("\n")
    .filter(line => !(/\{\{ref \d+\}\}/.test(line) && absentNames.some(name => line.trimStart().startsWith(name))))
    .join("\n")
    .replace(/\{\{ref (\d+)\}\}/g, (marker, index) => renumber.has(Number(index)) ? `{{ref ${renumber.get(Number(index))}}}` : marker);
}

// Shot sizes from widest to tightest; compound sizes come before the sizes they contain. The Chinese forms are
// \u5927\u9060\u666f (extreme wide), \u4e2d\u9060\u666f (medium wide), \u9060\u666f (wide), \u5168\u666f (full),
// \u5927\u7279\u5beb (extreme close-up), \u8fd1\u666f (medium close), \u7279\u5beb (close-up) and \u4e2d\u666f (medium), in
// traditional or simplified characters.
const sizeRanks: [RegExp, number][] = [
  [/\u5927[\u9060\u8fdc]\u666f|extreme (?:wide|long)/i, 7],
  [/\u4e2d[\u9060\u8fdc]\u666f|medium (?:wide|long)/i, 5],
  [/[\u9060\u8fdc]\u666f|wide|long shot|establishing/i, 6],
  [/\u5168\u666f|full/i, 4],
  [/\u5927\u7279[\u5beb\u5199]|extreme close/i, 0],
  [/\u8fd1\u666f|medium close/i, 2],
  [/\u7279[\u5beb\u5199]|close/i, 1],
  [/\u4e2d\u666f|medium/i, 3],
];
const sizeRank = (size = "") => sizeRanks.find(([pattern]) => pattern.test(size))?.[1] ?? -1;

// A "Master shot: 4 - reason" line, also "\u4e3b\u93e1\u982d\uff1a\u7b2c 4 \u93e1 \u2014 reason" in traditional or simplified
// Chinese, written by "Generate shot list" after the table.
const masterLine = /^[\s*#>-]*(?:master shot|\u4e3b[\u93e1\u955c][\u982d\u5934])[\s*]*[:\uff1a][\s*]*(?:shot\s*|\u7b2c\s*)?(\d+)\s*[\u93e1\u955c]?[\s*]*(?:[\u2014\u2013:\uff1a(\uff08-]+\s*)?(.*?)[\s)\uff09*]*$/im;

/** The master shot a shot list names, or else the shot with the most characters in frame, then the widest, then the earliest. */
export type MasterShotSuggestion = { shot: number; reason?: string; size?: string; cast: string[] };

export function suggestMasterShot(markdown: string, spans: ShotSpan[]): MasterShotSuggestion | undefined {
  const named = masterLine.exec(markdown);
  const namedShot = named ? spans.find(span => span.shot === Number(named[1])) : undefined;
  if (namedShot) return { shot: namedShot.shot, reason: named![2]!.trim(), size: namedShot.size, cast: [] };
  // People are counted from the cast cell itself, so a shot with people always beats an empty one even when the names
  // differ from the character images; an empty marker such as "none" or "\u7121" / "\u65e0" counts as nobody.
  const best = [...spans].sort((a, b) => castNames(b).length - castNames(a).length || sizeRank(b.size) - sizeRank(a.size) || a.shot - b.shot)[0];
  return best && { shot: best.shot, size: best.size, cast: castNames(best) };
}
/**
 * The people a shot's cast cell names, split on commas, slashes and semicolons (also their full-width forms); an empty
 * marker such as "none" or "\u7121" / "\u65e0" counts as nobody.
 */
export function castNames(span: Pick<ShotSpan, "cast">) {
  return (span.cast ?? "").split(/[,\uff0c\u3001;\uff1b/]+/)
    .map(name => name.replace(/^[\s(\uff08[]+|[\s)\uff09\]]+$/g, ""))
    .filter(name => name && !/^(?:\u7121|\u65e0|none|n\/a|-+|\u2014+)$/i.test(name));
}
