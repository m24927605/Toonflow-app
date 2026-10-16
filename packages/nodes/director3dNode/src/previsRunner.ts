import { translate } from "@toonflow/i18n/vue";
import type { NodeAiRequest } from "@toonflow/nodes-scaffold/runtime";
import { createDirectorDraft } from "./agentTools";
import { directorPrompt, mannequinsAllowed, mannequinsForbidden } from "./agentPrompt";
import { describeBlocking, frameShot, framedPeople, framingIssues } from "./blocking";
import { anchorSchema, type CameraAnchor } from "./motion";
import { previsSpecPrompt, readPrevisSpec, type PrevisSpec, type SpecShot } from "./previsSpec";
import { buildSet, ceilingOf, emptyShotView, figureScene, renderSettings, stageShots } from "./previsStage";
import { renderImage, renderVideo } from "./renderMedia";
import { getSceneLighting, type SceneDocument, type SceneSettings } from "./scene";
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
 * The previs of one framed shot: the opening frame as the colour layout image and as a depth map for depth-controlled
 * keyframes, both from `still` (the opening with jointed figures), and the colour animation as the previs video.
 */
async function exportShot(scene: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal, settings: SceneSettings, still: { scene: SceneDocument; plan: DirectorPlan }) {
  const lighting = getSceneLighting(scene);
  const anchor = anchorSchema.parse({ ...plan.cameraFrames[0]!.view, time: 0 });
  const layout = await renderImage(still.scene, anchor, aspect, 0, signal, still.plan, lighting, settings, "color");
  const depth = await renderImage(still.scene, anchor, aspect, 0, signal, still.plan, lighting, settings, "depth");
  const video = await renderVideo(scene, plan, aspect, signal, () => {}, lighting, settings, "color");
  return { layout, depth, video };
}

const poseBackground = "#e6e6e6";

/** Crops a render to the pixels that differ from its plain background, with a margin, so the figure fills the image. */
async function cropToFigure(image: Blob) {
  const bitmap = await createImageBitmap(image);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const [r, g, b] = [1, 3, 5].map(index => parseInt(poseBackground.slice(index, index + 2), 16)) as [number, number, number];
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (Math.abs(data[at]! - r) + Math.abs(data[at + 1]! - g) + Math.abs(data[at + 2]! - b) < 24) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return undefined;
  const margin = Math.round(0.08 * Math.max(right - left, bottom - top));
  const [x, y] = [Math.max(0, left - margin), Math.max(0, top - margin)];
  const [w, h] = [Math.min(width, right + margin + 1) - x, Math.min(height, bottom + margin + 1) - y];
  const cropped = new OffscreenCanvas(w, h);
  cropped.getContext("2d")!.drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return cropped.convertToBlob({ type: "image/png" });
}

/**
 * Each person of a shot's opening alone as a light grey, lit jointed figure on a plain backdrop, whole, from the shot
 * camera's direction and cropped to them: the textureless mannequin render that pose transfer with the VNCCS PoseStudio LoRA takes
 * as its pose (recipe from the Apache-2.0 qwen21-nsfw-pose-skill,
 * github.com/Arekejoker/qwen21-nsfw-pose-skill).
 */
async function renderPoses(still: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal) {
  const view = plan.cameraFrames[0]!.view;
  const { position, fov } = view.camera;
  const target = view.controls.target;
  // A key light from above, 40 degrees to the camera's left of its view, so the figure reads as a solid body.
  const lighting = {
    globalEnabled: true, globalIntensity: 0.6, sunEnabled: true, color: "#ffffff", intensity: 2.4, elevation: 40,
    azimuth: Math.atan2(position.x - target.x, position.z - target.z) * 180 / Math.PI - 40,
  };
  const poses: Record<string, Blob> = {};
  for (const figure of still.objectList.filter(object => object.objType === "mannequin" && object.name)) {
    const solo: SceneDocument = {
      ...still,
      sceneConfig: { ...still.sceneConfig, scene: { background: poseBackground }, lights: [] },
      objectList: [{ ...figure, material: { type: "standard", color: "#c4c4c4", roughness: 0.8 } }],
    };
    // The whole body seen from the shot camera's direction: pose transfer keeps a full-body posture but loses one cut to
    // a bust, so the camera backs off along its own line until 2.4 m of height fits.
    const centre = { x: figure.position.x, y: figure.position.y + 0.75, z: figure.position.z };
    const away = { x: position.x - target.x, y: position.y - target.y, z: position.z - target.z };
    const length = Math.hypot(away.x, away.y, away.z) || 1;
    const distance = 1.2 / Math.tan(fov * Math.PI / 360);
    const anchor = anchorSchema.parse({
      camera: { ...view.camera, position: { x: centre.x + away.x / length * distance, y: centre.y + away.y / length * distance, z: centre.z + away.z / length * distance } },
      controls: { target: centre }, time: 0,
    });
    const image = await renderImage(solo, anchor, aspect, 0, signal, undefined, lighting, { gridVisible: false, skyVisible: false }, "color");
    const cropped = await cropToFigure(image);
    if (cropped) poses[figure.name!] = cropped;
  }
  return poses;
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
 * The film's previs plan, every shot's framed plan, the measured blocking of each shot's opening as text for keyframe
 * prompts, and who each shot shows, in its opening and at any moment, for the keyframe and the clip to name.
 */
export type PrevisPlan = { spec: PrevisSpec; plans: SavedPlan[]; blocking: string[]; framed: { opening: string[]; shown: string[]; gaze: Record<string, string> }[] };

/**
 * Plans the previs of every shot without a person: the director model writes one plan for the whole film (the set,
 * where people are and move, the camera's side, angle and move) and code builds the set, stages each shot from where
 * the previous one ended, frames the camera from the shot size, checks the framing, describes the blocking and finds
 * who is in frame. Nothing is rendered, so the texts written from the blocking need not wait for the renders.
 */
export async function planPrevis(options: {
  generate: Generate; providerId: string; modelId: string; shots: (SpecShot & { size: string })[]; aspect: number; signal: AbortSignal;
}): Promise<PrevisPlan> {
  const spec = await writeSpec(options, options.shots);
  const scene = buildSet(spec);
  const ceiling = ceilingOf(spec);
  const plans: SavedPlan[] = [];
  const blocking: string[] = [];
  const framed: PrevisPlan["framed"] = [];
  for (const [index, staged] of stageShots(spec, options.shots).entries()) {
    const { shot, seconds, tracks, subjects, camera } = staged;
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
    blocking.push(await describeBlocking(scene, plan, options.aspect, true));
    framed.push(await framedPeople(scene, plan, options.aspect));
  }
  return { spec, plans, blocking, framed };
}

/**
 * Renders the shots of a previs plan in order, skipping the `rendered` ones, so a stopped run carries on after them.
 * People are columns in the previs video and jointed figures in the opening's still images, both posed by code.
 */
export async function renderPrevis(options: {
  plan: Pick<PrevisPlan, "spec" | "plans">; shots: SpecShot[]; rendered: number[]; aspect: number; signal: AbortSignal;
  onShot: (result: { shot: number; layout: Blob; depth: Blob; video: Blob; poses: Record<string, Blob> }) => Promise<void>;
}) {
  const { spec, plans } = options.plan;
  const scene = buildSet(spec);
  for (const [index, staged] of stageShots(spec, options.shots).entries()) {
    if (options.rendered.includes(staged.shot)) continue;
    options.signal.throwIfAborted();
    const plan = plans[index]!;
    // The stills show the opening with jointed figures and no motion, which the people's tracks would move.
    const still = figureScene(scene, staged);
    const exported = await exportShot(scene, plan, options.aspect, options.signal, renderSettings(spec), { scene: still, plan: { ...plan, tracks: [] } });
    const poses = await renderPoses(still, plan, options.aspect, options.signal);
    await options.onShot({ shot: staged.shot, ...exported, poses });
  }
}
