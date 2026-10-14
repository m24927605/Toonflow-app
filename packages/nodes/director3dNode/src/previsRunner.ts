import { translate } from "@toonflow/i18n/vue";
import type { NodeAiRequest } from "@toonflow/nodes-scaffold/runtime";
import { createDirectorDraft } from "./agentTools";
import { directorPrompt, mannequinsAllowed, mannequinsForbidden } from "./agentPrompt";
import { describeBlocking } from "./blocking";
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

/**
 * Blocks and exports every shot in order without a person: the first instruction builds the set, each later shot
 * starts from the previous shot's plan. People are cylinders; mannequins are never used here.
 */
export async function runPrevis(options: {
  generate: Generate; providerId: string; modelId: string; shots: { shot: number; instruction: string }[]; aspect: number; signal: AbortSignal;
  onShot: (result: { shot: number; layout: Blob; video: Blob; blocking: string; scene: SceneDocument; plans: SavedPlan[] }) => Promise<void>;
}) {
  let scene = createEmptyScene();
  const plans: SavedPlan[] = [];
  for (const { shot, instruction } of options.shots) {
    options.signal.throwIfAborted();
    const basePlan = plans.at(-1);
    const result = await planShot({ ...options, instruction, scene, basePlan, plans, allowMannequins: false, selectedPlanId: basePlan?.id });
    scene = result.scene;
    const plan: SavedPlan = { ...result.plan, id: crypto.randomUUID(), instruction };
    plans.push(plan);
    const exported = await exportShot(scene, plan, options.aspect, options.signal);
    await options.onShot({ shot, ...exported, scene, plans });
  }
}
