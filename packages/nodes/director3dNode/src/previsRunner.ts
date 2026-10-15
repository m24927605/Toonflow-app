import { translate } from "@toonflow/i18n/vue";
import type { NodeAiRequest } from "@toonflow/nodes-scaffold/runtime";
import { createDirectorDraft } from "./agentTools";
import { directorPrompt, mannequinsAllowed, mannequinsForbidden } from "./agentPrompt";
import { describeBlocking, framingIssues, reframeShot, type Posture } from "./blocking";
import { anchorSchema, type CameraAnchor } from "./motion";
import { renderImage, renderVideo } from "./renderMedia";
import { createEmptyScene, getSceneLighting, type LightingSettings, type SceneDocument, type SceneSettings } from "./scene";
import { directorPlanSchema, type DirectorPlan } from "./sceneAnimation";

type Generate = (request: Omit<NodeAiRequest, "onEvent">) => Promise<unknown>;
export type SavedPlan = DirectorPlan & { id: string; instruction?: string };

/**
 * One instruction of the director agent: edits a draft of the scene and the selected plan with its tools, and returns
 * the new scene and plan. Shared by the node's Generate and the headless previs runner.
 */
export async function planShot(options: {
  generate: Generate; providerId: string; modelId: string; instruction: string; scene: SceneDocument; basePlan?: DirectorPlan; plans: SavedPlan[];
  allowMannequins: boolean; anchors?: CameraAnchor[]; selectedPlanId?: string; references?: NodeAiRequest["references"]; directory?: string;
}) {
  const { generate, scene, basePlan, plans, allowMannequins, instruction } = options;
  const draft = createDirectorDraft(
    JSON.parse(JSON.stringify(scene)),
    basePlan ? directorPlanSchema.parse({ name: basePlan.name, duration: basePlan.duration, tracks: basePlan.tracks, cameraFrames: basePlan.cameraFrames }) : undefined,
    JSON.parse(JSON.stringify(plans)),
    allowMannequins,
  );
  const references = (options.anchors ?? []).map((value, index) => {
    const { camera, controls } = anchorSchema.parse(value);
    return { order: index + 1, camera, controls };
  });
  await generate({
    references: options.references ?? [], providerId: options.providerId, modelId: options.modelId,
    systemPrompt: `${directorPrompt}\n${allowMannequins ? mannequinsAllowed : mannequinsForbidden}`,
    prompt: JSON.stringify({ instruction, references, selectedPlanId: options.selectedPlanId ?? "", document: draft.summary() }),
    directory: options.directory, tools: draft.tools,
  });
  if (!draft.edited) throw new Error(translate("The director agent left the plan unchanged; try again"));
  const result = draft.read();
  return { scene: draft.sceneChanged ? result.scene : scene, sceneChanged: draft.sceneChanged, plan: result.plan };
}

/**
 * The previs of one blocked shot: the opening frame as the colour layout image and as a depth map for depth-controlled
 * keyframes, the colour animation as the previs video, and the measured blocking of the opening frame as text for
 * keyframe prompts.
 */
export async function exportShot(scene: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal, lighting: LightingSettings = getSceneLighting(scene), settings: SceneSettings = { gridVisible: true, skyVisible: true }, onProgress: (value: number) => void = () => {}) {
  const anchor = anchorSchema.parse({ ...plan.cameraFrames[0]!.view, time: 0 });
  const blocking = await describeBlocking(scene, plan, aspect);
  const layout = await renderImage(scene, anchor, aspect, 0, signal, plan, lighting, settings, "color");
  const depth = await renderImage(scene, anchor, aspect, 0, signal, plan, lighting, settings, "depth");
  const video = await renderVideo(scene, plan, aspect, signal, onProgress, lighting, settings, "color");
  return { layout, depth, video, blocking };
}

// Times the director agent may fix a shot whose framing check fails before the camera is framed by computation.
const framingRetries = 1;

/** The opening, middle and end frames of a plan, the camera at its last keyframe before each moment. */
async function reviewFrames(scene: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal) {
  const frames: Blob[] = [];
  for (const time of [0, plan.duration / 2, Math.max(0, plan.duration - 0.05)]) {
    const view = plan.cameraFrames.findLast(frame => frame.time <= time) ?? plan.cameraFrames[0]!;
    frames.push(await renderImage(scene, anchorSchema.parse({ ...view.view, time }), aspect, time, signal, plan, getSceneLighting(scene), { gridVisible: true, skyVisible: true }, "color"));
  }
  return frames;
}

/**
 * Has the director model look at a blocked shot's frames, which the geometric checks cannot judge against the story:
 * the shot size and angle, who stands where and how people relate and move. Returns what to change, or nothing; a
 * reply that cannot be read counts as nothing, since the geometry already passed.
 */
async function lookAtShot(options: { generate: Generate; providerId: string; modelId: string; signal: AbortSignal }, instruction: string, blocking: string, frames: string[]) {
  const prompt = [
    "A previs director was given the task below for one shot of a short film.",
    "",
    instruction,
    "",
    `The last three images are the opening, middle and end frames of the shot they blocked: people are grey cylinders and the set is plain blocks. Measured at the opening frame: ${blocking}.`,
    "Check only the staging against the shot list: the shot size and camera angle, who is in frame and where, how the people relate to each other and to the set, and how they move over the three frames. Ignore the plain look.",
    "Reply with JSON only: {\"ok\": true} when it matches, or {\"ok\": false, \"issues\": [\"what to change\"]}.",
  ].join("\n");
  const reply = await options.generate({
    providerId: options.providerId, modelId: options.modelId, prompt, signal: options.signal,
    references: frames.map(url => ({ dataType: "IMAGE" as const, value: { url, mimeType: "image/png" } })),
  }) as { text?: string };
  try {
    const verdict = JSON.parse(/\{[\s\S]*\}/.exec(reply.text ?? "")?.[0] ?? "{}") as { ok?: boolean; issues?: unknown };
    return verdict.ok === false && Array.isArray(verdict.issues) ? verdict.issues.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** A shot where everyone holds the pose the previous shot ended on, for when the agent cannot block it. */
function heldPlan(previous: DirectorPlan, shot: number, seconds: number): DirectorPlan {
  return {
    name: `Shot ${shot}`, duration: seconds,
    tracks: previous.tracks.map(track => {
      const last = track.frames.at(-1)!;
      return { ...track, frames: [{ ...last, time: 0 }, { ...last, time: seconds }] };
    }),
    cameraFrames: [{ ...previous.cameraFrames.at(-1)!, time: 0 }],
  };
}

/**
 * Blocks and exports every shot in order without a person: the first instruction builds the set, each later shot
 * starts from the previous shot's plan, or from `start`, the set and plans a stopped run had reached. People are
 * cylinders; mannequins are never used here. Since no one looks at the blocking, each shot's framing is checked and
 * handed back to the agent to fix, then framed by computation from the shot size; a shot the agent cannot block in two
 * tries (a stuck or looping model) holds the previous shot's positions and is framed by computation. A shot that still
 * fails, or a first shot the agent cannot block, stops.
 */
export async function runPrevis(options: {
  generate: Generate; providerId: string; modelId: string; shots: { shot: number; instruction: string; cast: string[]; size: string; seconds: number; angled: boolean; postures: Record<string, Posture> }[];
  aspect: number; signal: AbortSignal;
  start?: { scene: SceneDocument; plans: SavedPlan[] };
  /** Saves an image the director model looks at and returns its workspace path. */
  saveImage: (name: string, image: Blob) => Promise<string>;
  onShot: (result: { shot: number; layout: Blob; depth: Blob; video: Blob; blocking: string; scene: SceneDocument; plans: SavedPlan[] }) => Promise<void>;
}) {
  let scene = options.start?.scene ?? createEmptyScene();
  const plans: SavedPlan[] = [...options.start?.plans ?? []];
  for (const { shot, instruction, cast, size, seconds, angled, postures } of options.shots) {
    options.signal.throwIfAborted();
    const basePlan = plans.at(-1);
    // A failed fix only drops that fix; `required` marks the one attempt whose failure stops the run.
    const attempt = (instruction: string, from: { scene: SceneDocument; plan?: DirectorPlan }, required = false) =>
      planShot({ ...options, instruction, scene: from.scene, basePlan: from.plan, plans, allowMannequins: false, selectedPlanId: basePlan?.id })
        .catch((error: unknown) => {
          if (options.signal.aborted || required) throw error;
          console.warn(`Shot ${shot}: the director agent failed`, error);
          return undefined;
        });
    // The model now and then answers with text instead of a tool call, so a shot gets a second try; only the first
    // shot, which has no previous shot to hold, stops the run when both fail.
    const planned = await attempt(instruction, { scene, plan: basePlan }) ?? await attempt(instruction, { scene, plan: basePlan }, !basePlan);
    let result = planned ?? { scene, plan: heldPlan(basePlan!, shot, seconds) };
    const check = (from: typeof result) => framingIssues(from.scene, from.plan, options.aspect, cast, angled, postures);
    let issues = await check(result);
    for (let retry = 0; planned && issues.hard.length + issues.overlap.length + issues.soft.length && retry < framingRetries; retry++) {
      options.signal.throwIfAborted();
      const fix = `${instruction}\n\nYour blocking of this shot fails the framing check. Fix it, moving the camera or the objects in the way, and keep the rest:\n${[...issues.hard, ...issues.overlap, ...issues.soft].join("\n")}`;
      const fixed = await attempt(fix, result);
      if (!fixed) break;
      result = fixed;
      issues = await check(result);
    }
    // A held plan still has the previous shot's camera, so it is always framed for this shot's people and size.
    if (!planned || issues.hard.length || issues.overlap.length) {
      result = { ...result, plan: await reframeShot(result.scene, result.plan, options.aspect, cast, size) };
      issues = await check(result);
    }
    if (issues.hard.length) throw new Error(`Shot ${shot}: ${issues.hard.join(" ")}`);
    if (issues.overlap.length) console.warn(`Shot ${shot}: kept with people overlapping`, issues.overlap);
    // The director model then looks at the agent's blocking and hands it back once with what it saw; a fix that breaks
    // the geometry is dropped and the shot keeps the blocking that passed.
    if (planned) {
      const frames = await reviewFrames(result.scene, result.plan, options.aspect, options.signal);
      const paths = await Promise.all(frames.map((frame, index) => options.saveImage(`shot${shot}Review${index + 1}.png`, frame)));
      const seen = await lookAtShot(options, instruction, await describeBlocking(result.scene, result.plan, options.aspect), paths);
      const fixed = seen.length ? await attempt(`${instruction}\n\nA look at the rendered frames found problems with the staging. Fix them, moving the camera or the people, and keep the rest:\n${seen.join("\n")}`, result) : undefined;
      if (fixed && !(await check(fixed)).hard.length) result = fixed;
    }
    scene = result.scene;
    const plan: SavedPlan = { ...result.plan, id: crypto.randomUUID(), instruction };
    plans.push(plan);
    const exported = await exportShot(scene, plan, options.aspect, options.signal);
    await options.onShot({ shot, ...exported, scene, plans });
  }
}
