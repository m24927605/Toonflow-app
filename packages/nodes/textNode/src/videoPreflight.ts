import { locale, t } from "@toonflow/i18n/vue";
import type { ShotSpan } from "@toonflow/node-shared/shotList";
import { languageOf, parseDialogue } from "@toonflow/node-shared/videoPrompt";

/**
 * Stored on a video node as `preflight`, and read by the video generation node: the prompt that was checked, so
 * editing it afterwards voids the result, and whether it passed.
 */
export type VideoPreflight = { prompt: string; score: number; issues: string[]; passed: boolean };

// MiniMax H3 truncates longer prompts.
const maxPromptLength = 7000;
// Gate 1 of the cinematic-director QC checklist, with keyframe integrity judged from the shot list's cells, since the
// reviewing model reads text only.
const weights = { story: 20, blocking: 15, firstFrame: 25, hygiene: 20, continuity: 20 };
export const passingScore = 80;
// The review's findings are shown to the user, so they are written in the interface language.
const localeNames: Record<string, string> = { "zh-TW": "Traditional Chinese", "zh-CN": "Simplified Chinese", en: "English" };

/** Checks that need no model: structure, dialogue against the shot list, length and duration. */
export function checkVideoPrompt(prompt: string, span: ShotSpan, duration: number, previs = false, triggers: string[] = []) {
  const issues: string[] = [];
  if (!prompt.startsWith("For the target video, at 0.00 seconds into the target video, <Picture 1>")) issues.push(t`The prompt does not start with the first-frame line for <Picture 1>.`);
  for (const field of ["integrated_multimodal_description: [Shot 1]", "overall_soundscape:", "non_diegetic_music:"]) {
    if (!prompt.includes(field)) issues.push(t`The prompt is missing ${field}.`);
  }
  if (!/non_diegetic_music:\s*N\/A\s*$/i.test(prompt)) issues.push(t`non_diegetic_music must be N/A: music is laid over the joined film later.`);
  const spoken = [...prompt.matchAll(/<d>\[(\w+)\]\s*([\s\S]*?)<\/d>/g)].map(match => ({ language: match[1]!, words: match[2]!.trim() }));
  const expected = parseDialogue(span.dialogue);
  if (spoken.length !== expected.length || expected.some((line, index) => spoken[index]?.words !== line.words)) {
    issues.push(t`The spoken lines do not match the shot list's dialogue cell exactly.`);
  } else if (expected.some((line, index) => spoken[index]!.language !== languageOf(line.words))) {
    issues.push(t`A spoken line has the wrong language tag.`);
  }
  // The previs reference must be named as a blocking guide, or H3 takes its grey boxes as the look of the shot.
  if (previs && !/<Video 1>[^\n]*(?:blocking|grey-box|previs)/i.test(prompt)) issues.push(t`The prompt does not name <Video 1> as a blocking-only previs.`);
  for (const trigger of triggers) if (!prompt.includes(trigger)) issues.push(t`The prompt never names the person with the trigger word ${trigger}.`);
  if (/\{\{ref \d+\}\}|\[\[LINE \d+\]\]/.test(prompt)) issues.push(t`The prompt still contains unfilled markers.`);
  if (prompt.length > maxPromptLength) issues.push(t`The prompt is ${prompt.length} characters; MiniMax H3 cuts it off after ${maxPromptLength}.`);
  if (duration < 4 || duration > 15) issues.push(t`The duration of ${duration} s is outside MiniMax H3's 4–15 s.`);
  return issues;
}

const describeRow = (label: string, span?: ShotSpan) => span?.row ? [`${label} (shot ${span.shot}):`, span.row] : [`${label}: none`];

/**
 * Instructions for the text model that reviews one written prompt against Gate 1. They go to the model only and stay
 * in English; the issues it lists are written in the shot list's language for the user to read.
 */
export function reviewInstructions(span: ShotSpan, scripts: number, duration: number, prompt: string, previous?: ShotSpan, next?: ShotSpan, previs = false) {
  const shotList = `{{ref ${scripts + 1}}}`;
  return [
    scripts
      ? `${Array.from({ length: scripts }, (_, index) => `{{ref ${index + 1}}}`).join(", ")} is the original script and ${shotList} is its shot list.`
      : `${shotList} is the shot list.`,
    `Review this MiniMax H3 video prompt for shot ${span.shot}, a ${duration}-second clip that starts from the shot's keyframe <Picture 1>, before it is paid for.`,
    ...span.header ? ["Shot list header:", span.header] : [],
    ...describeRow("This shot's row", span),
    ...describeRow("Previous shot's row", previous),
    ...describeRow("Next shot's row", next),
    "The prompt:",
    "<<<",
    prompt,
    ">>>",
    ...previs ? ["The clip is also given <Video 1>, the shot's grey-box previs; the sentence naming it a blocking-only guide is required, so never flag it, but flag movements or camera moves that contradict it."] : [],
    "The <d>[Language] ...</d> tags are MiniMax H3's required format for spoken lines and the words in them come verbatim from the shot list; never flag the tags or the words themselves.",
    "Score each category from 0 (fails) to 5 (fully meets):",
    "- story: the shot does the job its row and the script give it, and adds nothing that serves no purpose.",
    `- blocking: the action has a clear start, motion and end, with at most one camera move, as the row's camera cell asks, and fits in ${duration} seconds.`,
    "- firstFrame: the opening state (who is in frame, where, posture, what they hold, clothing, light) matches the row's cast and character-state cells, and adds no person or object they do not have.",
    "- hygiene: one main action, one camera move, a clear end state, the unchanged appearance and set stated, plausible physics and anatomy, no on-screen text, and only the row's dialogue spoken.",
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
