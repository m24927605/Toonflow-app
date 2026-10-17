import type { Production } from "./state";
import type { ProductionClip } from "./video";

/**
 * What went wrong in a clip that failed its check, and why: each major problem with its cause, the change the prompt
 * needs, and a rule worth following in every other shot of the film.
 */
export type ClipDiagnosis = {
  causes: { problem: string; cause: "prompt" | "reference" | "model" | "check"; why: string }[];
  fix: string;
  lesson?: string;
};

// A clip is rendered again at most this many times, each from a prompt rewritten after its diagnosis; the best of the
// renders is kept and flagged after that.
export const maxCorrections = 2;
// How often a prompt is reviewed and rewritten before it goes to the GPU.
export const reviewRounds = 2;
// The lessons of a film shared with every later prompt, the newest kept.
const maxLessons = 8;

export const lessonsOf = (production: Production) => production.lessons?.length
  ? `\n\nLessons from clips of this film that failed their check, to follow in this prompt too:\n${production.lessons.map(lesson => `- ${lesson}`).join("\n")}`
  : "";

/**
 * The review of a written clip prompt before any GPU time: a checklist of the faults that made earlier clips fail, each
 * of them something the prompt says, so a text model can find them in the words alone. `scope` says which seconds a
 * part of a long take covers.
 */
export function promptReview(production: Production, row: string, draft: string, scope = "") {
  return [
    "You review a prompt written for the MiniMax H3 video model against the shot-list row it renders. The row (shot size, camera, action, dialogue, cast, state):",
    row,
    // A part of a long take covers only some seconds of the row.
    ...scope ? [`This prompt renders only part of the shot: ${scope.trim()} Judge the row's action, its order and the opening state only for those seconds; a part after the first opens where the part before ends, and the actions of the other parts are not missing.`] : [],
    "The prompt:",
    draft,
    "Find every one of these faults in the prompt:",
    "- The opening already shows the state the row's action leads to, so the action cannot happen: someone who comes in is already inside, someone who stands up is already standing, someone who sits down is already seated.",
    "- Part of the row's action is missing, out of order, or undone by a later sentence.",
    "- A movement that is physically impossible, such as a sliding door pushed inward.",
    "- Two different camera moves, shot sizes or views of the same person, such as a following camera that also holds static, or profile and three-quarter at once.",
    "- Words about anyone's face, hair, body or clothes beyond the picture they come from.",
    "- Distances or heights in metres or other numbers of the set.",
    "- A sentence that keeps someone's eyes on one side while the row's action needs them on something else, such as on a cup they smell.",
    "- Anyone looking forward, ahead, at the camera, at the viewer, or the word lens, unless the row asks for a look at the camera.",
    "Report only faults you can quote from the prompt; do not suggest style changes.",
    "Reply with JSON only: {\"problems\": [\"the fault, quoting the words\"]}, with an empty list when there is none.",
  ].join("\n") + lessonsOf(production);
}

/** The faults a review found; a reply that cannot be read finds none, as the prompt was already checked by rule. */
export function readReview(reply: string) {
  try {
    const value = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? "") as { problems?: unknown };
    return Array.isArray(value.problems) ? value.problems.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * The diagnosis of a clip that failed: the model sees the same frames the check saw and decides for each major problem
 * whether the prompt caused it, a reference picture did, the video model ignored a clear prompt, or the check itself
 * was wrong because the clip does what the row and the script ask.
 */
export function diagnosisPrompt(production: Production, item: ProductionClip, row: string, gazes: string, looks: number) {
  const earlier = (item.attempts ?? []).map((attempt, index) =>
    `Render ${index + 1} failed with: ${attempt.check.issues.filter(issue => issue.major).map(issue => issue.problem).join("; ")}. Its prompt was then changed by: ${attempt.diagnosis.fix}`);
  return [
    `The first image is the shot's grey-box previs layout; the next ${looks} show how the people and the place must look; the last six are frames of the rendered clip.`,
    `The shot-list row (shot size, camera, action, dialogue, cast, state): ${row}`,
    ...gazes ? [`Where each person should look: ${gazes}.`] : [],
    `The prompt the clip was rendered from:\n${item.prompt}`,
    `A check of the frames found these major problems:\n${item.check!.issues.filter(issue => issue.major).map(issue => `- ${issue.problem}`).join("\n")}`,
    ...earlier.length ? [`Earlier renders of this shot:\n${earlier.join("\n")}`] : [],
    "For each problem decide its cause:",
    "- prompt: the prompt asked for what went wrong, contradicted itself, or left it open (quote the words);",
    "- reference: a reference picture shows it, such as a pose or a hairstyle, and the prompt did not override it;",
    "- model: the prompt asked clearly and the video model did otherwise;",
    "- check: the clip does what the row and the script ask and the check was wrong, such as judging a posture by the previs when the row says otherwise, or misreading the frames.",
    "Then write the fix: what the next prompt for this shot must say differently, concretely (for a model cause, make the action simpler, earlier and stated once, as the first thing that happens).",
    "If one cause would make any shot of any film fail, also write it as a lesson: one short general rule for writing prompts, with no names from this film.",
    "Reply with JSON only: {\"causes\": [{\"problem\": \"...\", \"cause\": \"prompt\", \"why\": \"...\"}], \"fix\": \"...\", \"lesson\": \"...\" or \"\"}.",
  ].join("\n") + lessonsOf(production);
}

/** Reads a diagnosis; one that cannot be read blames the prompt, so the clip is rewritten rather than passed. */
export function readDiagnosis(reply: string): ClipDiagnosis {
  try {
    const value = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? "") as { causes?: unknown; fix?: unknown; lesson?: unknown };
    const causes = (Array.isArray(value.causes) ? value.causes : []).flatMap(item => {
      const { problem, cause, why } = (item ?? {}) as Record<string, unknown>;
      return typeof problem === "string" && typeof cause === "string" && ["prompt", "reference", "model", "check"].includes(cause)
        ? [{ problem, cause: cause as ClipDiagnosis["causes"][number]["cause"], why: typeof why === "string" ? why : "" }] : [];
    });
    const fix = typeof value.fix === "string" ? value.fix.trim() : "";
    const lesson = typeof value.lesson === "string" && value.lesson.trim() ? value.lesson.trim() : undefined;
    return { causes, fix, lesson };
  } catch {
    return { causes: [], fix: "" };
  }
}

/**
 * Acts on a failed clip's diagnosis. A clip whose every major problem was the check's own mistake passes as it is. Any
 * other is set to be written and rendered again, its prompt told what failed and why, while it has corrections left
 * and the budget can pay for one (`affordable`); otherwise the render with the fewest major problems is kept, still
 * failed, for a person to look at, so the film is still finished. A lesson joins the film's lessons, which every later
 * prompt, review and diagnosis reads.
 */
export function applyDiagnosis(production: Production, item: ProductionClip, diagnosis: ClipDiagnosis, affordable: boolean) {
  const check = item.check!;
  const majors = check.issues.filter(issue => issue.major).length;
  // Every major problem must be covered by the diagnosis before the check is overruled.
  if (diagnosis.causes.length >= majors && diagnosis.causes.every(cause => cause.cause === "check")) {
    item.check = { ...check, passed: true, overruled: diagnosis.causes.map(cause => cause.why).join(" ") };
    return;
  }
  if (diagnosis.lesson && !production.lessons?.includes(diagnosis.lesson)) production.lessons = [...production.lessons ?? [], diagnosis.lesson].slice(-maxLessons);
  const attempts: NonNullable<ProductionClip["attempts"]> = [...item.attempts ?? [], { prompt: item.prompt!, parts: item.parts, video: item.video!, seed: item.seed, check, diagnosis }];
  if (affordable && attempts.length <= maxCorrections) {
    Object.assign(item, { attempts, prompt: undefined, parts: undefined, video: undefined, seed: undefined, check: undefined });
    return;
  }
  keepBest(Object.assign(item, { attempts }));
}

/** Gives a clip back the earlier render with the fewest major problems, its check still failed, for a person to see. */
export function keepBest(item: ProductionClip) {
  const count = (entry: NonNullable<ProductionClip["attempts"]>[number]) => entry.check.issues.filter(issue => issue.major).length;
  const best = item.attempts!.reduce((kept, entry) => count(entry) < count(kept) ? entry : kept);
  Object.assign(item, { prompt: best.prompt, parts: best.parts, video: best.video, seed: best.seed, check: best.check });
}

/** What the writer of a shot's prompt learns from its failed renders: what went wrong and what to change. */
export function correctionNote(item: ProductionClip) {
  const attempts = item.attempts ?? [];
  if (!attempts.length) return "";
  return `\n\nThis shot was rendered before and failed its check. Write the prompt so none of this happens again:\n${attempts.map((attempt, index) =>
    `Render ${index + 1}, from the prompt:\n${attempt.prompt}\nfailed with: ${attempt.check.issues.filter(issue => issue.major).map(issue => issue.problem).join("; ")}\nThe change needed: ${attempt.diagnosis.fix}`).join("\n\n")}`;
}

