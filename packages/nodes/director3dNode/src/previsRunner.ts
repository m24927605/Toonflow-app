import { translate } from "@toonflow/i18n/vue";
import type { NodeAiRequest } from "@toonflow/nodes-scaffold/runtime";
import { createDirectorDraft } from "./agentTools";
import { directorPrompt, mannequinsAllowed, mannequinsForbidden } from "./agentPrompt";
import { describeBlocking, frameShot, framingIssues } from "./blocking";
import { anchorSchema, type CameraAnchor } from "./motion";
import { previsSpecPrompt, readPrevisSpec, type PrevisSpec, type SpecShot } from "./previsSpec";
import { buildSet, ceilingOf, emptyShotView, renderSettings, stageShots } from "./previsStage";
import { renderImage, renderVideo } from "./renderMedia";
import { getSceneLighting, type LightingSettings, type SceneDocument, type SceneSettings } from "./scene";
import { directorPlanSchema, type DirectorPlan } from "./sceneAnimation";

type Generate = (request: Omit<NodeAiRequest, "onEvent">) => Promise<unknown>;
export type SavedPlan = DirectorPlan & { id: string; instruction?: string };

/**
 * One instruction of the director agent: edits a draft of the scene and the selected plan with its tools, and returns
 * the new scene and plan, for the node's Generate.
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

/**
 * Asks the director model for the previs plan of the whole film in one reply, and once more, with what is wrong, when
 * the reply cannot be used.
 */
async function writeSpec(options: { generate: Generate; providerId: string; modelId: string; signal: AbortSignal }, shots: SpecShot[]) {
  const prompt = previsSpecPrompt(shots);
  const ask = async (text: string) => ((await options.generate({ providerId: options.providerId, modelId: options.modelId, prompt: text, signal: options.signal }) as { text?: string }).text ?? "");
  const reply = await ask(prompt);
  const first = readPrevisSpec(reply, shots);
  if (first.spec) return first.spec;
  console.warn("The previs plan needs fixing", first.problems);
  const fixed = readPrevisSpec(await ask(`${prompt}\n\nYour plan:\n${reply}\n\nIt cannot be used yet. Output the whole JSON again with these fixed:\n${first.problems.map(problem => `- ${problem}`).join("\n")}`), shots);
  if (fixed.spec) return fixed.spec;
  throw new Error(`The previs plan cannot be used: ${fixed.problems.join(" ")}`);
}

/**
 * Blocks and exports every shot in order without a person: the director model writes one plan for the whole film (the
 * set, where people are and move, the camera's side, angle and move) and code builds the set, stages each shot from
 * where the previous one ended, frames the camera from the shot size and checks the framing. A stopped run passes the
 * plan and the shots it finished as `start` and carries on after them. People are cylinders; mannequins are never
 * used here.
 */
export async function runPrevis(options: {
  generate: Generate; providerId: string; modelId: string; shots: (SpecShot & { size: string })[];
  aspect: number; signal: AbortSignal;
  start?: { spec: PrevisSpec; plans: SavedPlan[] };
  onShot: (result: { shot: number; layout: Blob; depth: Blob; video: Blob; blocking: string; scene: SceneDocument; plans: SavedPlan[]; spec: PrevisSpec }) => Promise<void>;
}) {
  const spec = options.start?.spec ?? await writeSpec(options, options.shots);
  const scene = buildSet(spec);
  const ceiling = ceilingOf(spec);
  const plans: SavedPlan[] = [...options.start?.plans ?? []];
  for (const [index, { shot, seconds, tracks, subjects, camera }] of stageShots(spec, options.shots).entries()) {
    if (index < plans.length) continue;
    options.signal.throwIfAborted();
    const size = options.shots[index]!.size;
    const base: DirectorPlan = { name: `Shot ${shot}`, duration: seconds, tracks, cameraFrames: [{ time: 0, easing: "smooth", view: emptyShotView(spec) }] };
    const angled = camera.angle !== "eye";
    // Over a shoulder, the frame cuts the person in front on purpose, so only the people looked at are checked.
    let plan = await frameShot(scene, base, options.aspect, subjects, size, camera, ceiling);
    let issues = await framingIssues(scene, plan, options.aspect, subjects.filter(name => name !== camera.over), angled);
    // An over-the-shoulder view or a camera move that fails falls back to a held camera on the same side.
    if (issues.hard.length && (camera.over || camera.move !== "static")) {
      plan = await frameShot(scene, base, options.aspect, subjects, size, { ...camera, over: undefined, move: "static" }, ceiling);
      issues = await framingIssues(scene, plan, options.aspect, subjects, angled);
    }
    if (issues.hard.length) throw new Error(`Shot ${shot}: ${issues.hard.join(" ")}`);
    if (issues.overlap.length) console.warn(`Shot ${shot}: kept with people overlapping`, issues.overlap);
    plans.push({ ...plan, id: crypto.randomUUID() });
    const exported = await exportShot(scene, plan, options.aspect, options.signal, getSceneLighting(scene), renderSettings(spec));
    await options.onShot({ shot, ...exported, scene, plans, spec });
  }
}
