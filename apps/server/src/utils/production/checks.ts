import { mkdir, readFile } from "@toonflow/file";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { replyJson } from "./review";
import { productionDirectory, type Production } from "./state";

/** A vision model's verdict on a keyframe or a clip; `unreadable` marks a reply that could not be read. */
export type VisualCheck = { issues: { problem: string; kind: string; major: boolean }[]; passed: boolean; unreadable?: boolean };

/**
 * The kinds of problem a check sorts what it sees into. The model names problems well but weighs them badly (it failed
 * whole films over a hand not in a pocket and passed changed clothes with a high score), so code weighs them by kind:
 * the first ten are what a viewer watching the film once notices or misreads the story by, and fail the picture.
 */
const checkKinds = {
  missingPerson: "someone the row's cast names is not there, or another person stands in for them",
  extraPerson: "someone shows up who is not in the references, such as a stranger or a second copy of someone",
  identity: "someone's face, hair or clothes, or the place, differ from the reference images, or change between frames",
  deformed: "a face, hand, body or genitals are deformed, melted, fused or anatomically wrong",
  physics: "something physically impossible: someone floats, passes through furniture or another person, or bends in a way a body cannot",
  actionMissing: "the row's main action or pose does not happen or goes the wrong way, so a viewer cannot tell what happens",
  lensLook: "someone looks straight into the camera lens though the row does not ask for it",
  popping: "someone or something appears from nowhere, vanishes or jumps to another place",
  framing: "the shot is clearly wider or tighter than the row's shot size, or what the row centres on is out of frame",
  wardrobe: "someone wears clothes, or is clothed or naked, differently from the row's state",
  gaze: "someone looks at another person, thing or side than the row says, but not into the lens",
  detail: "a small difference from the row's wording, such as which hand holds something or a slightly different pose",
  timing: "an action still under way as the clip ends, or a beat a little early or late",
  other: "anything else a viewer would not notice",
};
const failingKinds = new Set(Object.keys(checkKinds).slice(0, 10));
const kindList = () => Object.entries(checkKinds).map(([kind, meaning]) => `"${kind}" ${meaning}`).join("; ");
const replyFormat = `Reply with JSON only: {"issues": [{"problem": "what you saw, and in which image", "kind": one of ${Object.keys(checkKinds).map(kind => `"${kind}"`).join(", ")}}]}, with an empty list when there is nothing wrong.`;

/** Reads a check's JSON: it passes without major problems; a reply that cannot be read fails rather than is trusted. */
export function readCheck(reply: string): VisualCheck {
  const unreadable = { issues: [{ problem: "The check's reply could not be read.", kind: "other", major: true }], passed: false, unreadable: true };
  try {
    const value = replyJson(reply, "issues") as { issues?: unknown };
    if (!Array.isArray(value.issues) || value.issues.some(item => !item || typeof item !== "object" || typeof (item as { problem?: unknown }).problem !== "string")) return unreadable;
    // A problem of no known kind counts as major, so a reply that leaves the kind out cannot pass a broken picture.
    const issues = (value.issues as { problem: string; kind?: unknown }[]).map(item => ({
      problem: item.problem, kind: String(item.kind ?? ""), major: !Object.hasOwn(checkKinds, String(item.kind)) || failingKinds.has(String(item.kind)),
    })).slice(0, 10);
    return { issues, passed: !issues.some(item => item.major) };
  } catch {
    return unreadable;
  }
}

export const majorProblems = (check: VisualCheck) => check.issues.filter(issue => issue.major).map(issue => issue.problem);

/**
 * Asks for every problem in a keyframe. Looks are judged against the reference images only: given a written description
 * of the picture as well, the model took the words for the picture. Poses, clothes and framing are judged against the
 * shot-list row and the contract's opening poses.
 */
export function keyframeCheckPrompt(row: string, poses: string, references: number, demands?: string) {
  return [
    `The first ${references} images show how the place and the people must look; the last image is the opening frame drawn for this shot of a film.`,
    `The shot-list row (shot size, camera, action, dialogue, cast, state): ${row}`,
    ...poses ? [`Where everyone is and how they hold themselves at the opening: ${poses}`] : [],
    "Judge the opening frame as the start of this shot: the right people in the right clothes or nudity, the poses and the framing the row and the poses give, faces and the place as in the reference images, and bodies, hands and genitals anatomically correct.",
    ...demands ? [demands] : [],
    `List every problem you see and give each the one kind that fits it best: ${kindList()}.`,
    replyFormat,
  ].join("\n");
}

/**
 * Asks for every problem in a clip, from frames across the part the film keeps. The action and the gaze are judged
 * against the row: judging looks alone, the check passed a jacket put on instead of taken off.
 */
export function clipCheckPrompt(row: string, prompt: string, references: number) {
  return [
    `The first ${references} images show how the place and the people must look; the last six are frames from the video clip at ${checkTimes.map(time => `${Math.round(time * 100)}%`).join(", ")} of the part the film keeps.`,
    `The shot-list row (shot size, camera, action, dialogue, cast, state): ${row}`,
    `The clip was asked for: ${prompt}`,
    "Judge what happens across the frames against the row: the action must happen as the row says, in the right direction (taking a jacket off is not putting it on), and no one looks into the camera lens unless the row asks for it. Compare faces, clothes and the place with the reference images, never with the words; clothes follow the row's state, so someone the row has naked is naked whatever their reference wears, and only their face is compared.",
    `List every problem you see and give each the one kind that fits it best: ${kindList()}. One soft or smeared frame during a fast movement is motion blur, not a problem.`,
    replyFormat,
  ].join("\n");
}

// Six frames across the part of the clip the film keeps, so an action is seen from start to end.
const checkTimes = [0.05, 0.25, 0.45, 0.65, 0.85, 0.98];

/**
 * The images a check reads, as base64 PNGs scaled to 640 px wide, which keeps the model's image reading short: the
 * references, then the keyframe or six frames of the kept part of the clip, saved beside the clips for a person to see.
 */
export async function checkImages(cwd: string, production: Production, name: string, references: string[], subject: { image: string } | { video: string; seconds: number }, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const folder = `${productionDirectory(production.id)}/checks`;
  await mkdir((await resolveWorkspacePath(cwd, folder, true)).path, { recursive: true });
  const shrink = async (source: string, target: string, seek = 0) => {
    const [input, output] = await Promise.all([resolveWorkspacePath(cwd, source), resolveWorkspacePath(cwd, target, true)]);
    await new Promise<void>((resolve, reject) => ffmpeg(input.path).seekInput(seek).frames(1).outputOptions(["-vf scale=640:-2"]).output(output.path).on("end", () => resolve()).on("error", reject).run());
    return output.path;
  };
  const paths = await Promise.all(references.map((image, index) => shrink(image, `${folder}/${name}Reference${index + 1}.png`)));
  if ("image" in subject) paths.push(await shrink(subject.image, `${folder}/${name}.png`));
  else for (const [index, share] of checkTimes.entries()) paths.push(await shrink(subject.video, `${folder}/${name}Frame${index + 1}.png`, subject.seconds * share));
  return Promise.all(paths.map(async path => Buffer.from(await readFile(path)).toString("base64")));
}
