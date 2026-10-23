import { locale, t } from "@toonflow/i18n/vue";
import type { ShotSpan } from "@toonflow/node-shared/shotList";
import { maxPromptLength, shotDialogue, validateVideoPrompt } from "@toonflow/node-shared/videoPrompt";

/**
 * Stored on a video node as `preflight`, and read by the video generation node: the prompt that was checked, so
 * editing it afterwards voids the result, and whether it passed.
 */
export type VideoPreflight = { prompt: string; score: number; issues: string[]; passed: boolean };

// Gate 1 of the cinematic-director QC checklist, with keyframe integrity judged from the shot list's cells, since the
// reviewing model reads text only.
const weights = { story: 20, blocking: 15, firstFrame: 25, hygiene: 20, continuity: 20 };
export const passingScore = 80;
// The review's findings are shown to the user, so they are written in the interface language.
const localeNames: Record<string, string> = { "zh-TW": "Traditional Chinese", "zh-CN": "Simplified Chinese", en: "English" };

/** Checks that need no model: plain prose, the dialogue against the shot list, trigger words, length and duration. */
export function checkVideoPrompt(prompt: string, span: ShotSpan, duration: number, triggers: string[] = []) {
  const issues: string[] = [];
  try { validateVideoPrompt(prompt); }
  catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  const spoken = [...prompt.matchAll(/"([^"]*)"/g)].map(match => match[1]!);
  const expected = shotDialogue(span);
  if (spoken.length !== expected.length || expected.some((line, index) => spoken[index] !== line.words)) {
    issues.push(t`The spoken lines do not match the shot list's dialogue cell exactly.`);
  }
  for (const trigger of triggers) if (!prompt.includes(trigger)) issues.push(t`The prompt never names the person with the trigger word ${trigger}.`);
  if (prompt.length > maxPromptLength) issues.push(t`The prompt is ${prompt.length} characters; Sulphur 2 takes at most ${maxPromptLength}.`);
  if (duration < 1 || duration > 20) issues.push(t`The duration of ${duration} s is outside Sulphur 2's 1–20 s.`);
  return issues;
}

const describeRow = (label: string, span?: ShotSpan) => span?.row ? [`${label} (shot ${span.shot}):`, span.row] : [`${label}: none`];

/**
 * Instructions for the text model that reviews one written prompt against Gate 1. They go to the model only and stay
 * in English; the issues it lists are written in the shot list's language for the user to read.
 */
export function reviewInstructions(span: ShotSpan, scripts: number, duration: number, prompt: string, previous?: ShotSpan, next?: ShotSpan, previs = false, keyframe = "") {
  const shotList = `{{ref ${scripts + 1}}}`;
  return [
    scripts
      ? `${Array.from({ length: scripts }, (_, index) => `{{ref ${index + 1}}}`).join(", ")} is the original script and ${shotList} is its shot list.`
      : `${shotList} is the shot list.`,
    `Review this Sulphur 2 (LTX-2.3) video prompt for shot ${span.shot}, a ${duration}-second clip that starts from the shot's keyframe as its first frame, before it is paid for.`,
    ...span.header ? ["Shot list header:", span.header] : [],
    ...describeRow("This shot's row", span),
    ...describeRow("Previous shot's row", previous),
    ...describeRow("Next shot's row", next),
    ...keyframe ? ["Actual first-frame observation from the vision model:", keyframe, "Flag any conflict between the observed opening and the required action; never repair it by inventing a different image or dropping the action."] : [],
    "The prompt:",
    "<<<",
    prompt,
    ">>>",
    ...previs ? ["The clip also follows the shot's grey-box previs as a depth control video, which fixes where people stand and move and the camera; flag movements or camera moves the prompt describes that contradict it."] : [],
    "The words in quotation marks come verbatim from the shot list; never flag the words themselves.",
    "Score each category from 0 (fails) to 5 (fully meets):",
    "- story: the shot does the job its row and the script give it, and adds nothing that serves no purpose.",
    `- blocking: the action has a clear start, motion and end, with at most one camera move, as the row's camera cell asks, and fits in ${duration} seconds.`,
    "- firstFrame: the opening state (who is in frame, where, posture, what they hold, clothing, light) matches the row's cast and character-state cells, and adds no person or object they do not have.",
    "- hygiene: Sulphur's caption format (one present-tense paragraph that opens with the style and camera, introduces each person, then commands every movement, line and sound in the order it happens, with the English meaning in brackets after each line that is not in English), one main action, one camera move, a clear end state, identity and unaffected attributes preserved, with required state changes allowed, plausible physics and anatomy, no on-screen text, each spoken line attributed to its speaker, and only the row's dialogue spoken.",
    "- continuity: the opening state follows from where the previous shot ends, and the ending leads into the next shot (positions, posture, props, light).",
    "Reply with only this JSON and nothing else:",
    "{\"story\": 0, \"blocking\": 0, \"firstFrame\": 0, \"hygiene\": 0, \"continuity\": 0, \"issues\": [\"...\"]}",
    `Each issue is one short sentence in ${localeNames[locale.value] ?? "English"} that names a problem and how to fix the prompt. List every category below 4 as an issue, and add any other improvement worth making; leave issues empty when nothing needs fixing.`,
  ].join("\n");
}

/** The weighted Gate 1 score and the issues from the review model's JSON reply. */
export function parseReview(reply: string) {
  const json = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  const data = JSON.parse(json) as Record<string, unknown>;
  let score = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = Number(data[key]);
    if (!Number.isFinite(value) || value < 0 || value > 5) throw new Error(`invalid ${key} score`);
    score += value / 5 * weight;
  }
  const issues = Array.isArray(data.issues) ? data.issues.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];
  return { score: Math.round(score), issues };
}
