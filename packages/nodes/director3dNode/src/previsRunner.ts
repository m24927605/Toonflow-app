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
 * The previs of one blocked shot: the opening frame as the colour layout image, the colour animation as the previs
 * video, and the measured blocking of the opening frame as text for keyframe prompts.
 */
export async function exportShot(scene: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal, lighting: LightingSettings = getSceneLighting(scene), settings: SceneSettings = { gridVisible: true, skyVisible: true }, onProgress: (value: number) => void = () => {}) {
  const anchor = anchorSchema.parse({ ...plan.cameraFrames[0]!.view, time: 0 });
  const blocking = await describeBlocking(scene, plan, aspect);
  const layout = await renderImage(scene, anchor, aspect, 0, signal, plan, lighting, settings, "color");
  const video = await renderVideo(scene, plan, aspect, signal, onProgress, lighting, settings, "color");
  return { layout, video, blocking };
}

// Times the director agent may fix a shot whose framing check fails before the camera is framed by computation.
const framingRetries = 1;

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
 * handed back to the agent to fix, then framed by computation from the shot size; a shot the agent cannot block at
 * all (a stuck or looping model) holds the previous shot's positions and is framed by computation. A shot that still
 * fails, or a first shot the agent cannot block, stops.
 */
export async function runPrevis(options: {
  generate: Generate; providerId: string; modelId: string; shots: { shot: number; instruction: string; cast: string[]; size: string; seconds: number; angled: boolean; postures: Record<string, Posture> }[];
  aspect: number; signal: AbortSignal;
  start?: { scene: SceneDocument; plans: SavedPlan[] };
  onShot: (result: { shot: number; layout: Blob; video: Blob; blocking: string; scene: SceneDocument; plans: SavedPlan[] }) => Promise<void>;
}) {
  let scene = options.start?.scene ?? createEmptyScene();
  const plans: SavedPlan[] = [...options.start?.plans ?? []];
  for (const { shot, instruction, cast, size, seconds, angled, postures } of options.shots) {
    options.signal.throwIfAborted();
    const basePlan = plans.at(-1);
    const attempt = (instruction: string, from: { scene: SceneDocument; plan?: DirectorPlan }) =>
      planShot({ ...options, instruction, scene: from.scene, basePlan: from.plan, plans, allowMannequins: false, selectedPlanId: basePlan?.id })
        .catch((error: unknown) => {
          if (options.signal.aborted || !basePlan) throw error;
          console.warn(`Shot ${shot}: the director agent failed`, error);
          return undefined;
        });
    const planned = await attempt(instruction, { scene, plan: basePlan });
    let result = planned ?? { scene, plan: heldPlan(basePlan!, shot, seconds) };
    const check = (from: typeof result) => framingIssues(from.scene, from.plan, options.aspect, cast, angled, postures);
    let issues = await check(result);
    for (let retry = 0; planned && issues.hard.length + issues.soft.length && retry < framingRetries; retry++) {
      options.signal.throwIfAborted();
      const fix = `${instruction}\n\nYour blocking of this shot fails the framing check. Fix it, moving the camera or the objects in the way, and keep the rest:\n${[...issues.hard, ...issues.soft].join("\n")}`;
      const fixed = await attempt(fix, result);
      if (!fixed) break;
      result = fixed;
      issues = await check(result);
    }
    // A held plan still has the previous shot's camera, so it is always framed for this shot's people and size.
    if (!planned || issues.hard.length) {
      result = { ...result, plan: await reframeShot(result.scene, result.plan, options.aspect, cast, size) };
      issues = await check(result);
    }
    if (issues.hard.length) throw new Error(`Shot ${shot}: ${issues.hard.join(" ")}`);
    scene = result.scene;
    const plan: SavedPlan = { ...result.plan, id: crypto.randomUUID(), instruction };
    plans.push(plan);
    const exported = await exportShot(scene, plan, options.aspect, options.signal);
    await options.onShot({ shot, ...exported, scene, plans });
  }
}
