import { translate } from "@toonflow/i18n/vue";
import type { NodeAiRequest } from "@toonflow/nodes-scaffold/runtime";
import { createDirectorDraft } from "./agentTools";
import { directorPrompt, mannequinsAllowed, mannequinsForbidden } from "./agentPrompt";
import { coveredPeople, describeBlocking, frameShot, framedPeople, framingIssues, smallFaces } from "./blocking";
import { anchorSchema, type CameraAnchor } from "./motion";
import { previsSpecPrompt, readPrevisSpec, type PrevisSpec, type SpecShot, previsSpecJsonSchema } from "./previsSpec";
import { buildSet, ceilingOf, emptyShotView, renderSettings, stageShots } from "./previsStage";
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
 * The previs of one framed shot: the opening frame as the colour layout image, which keyframes take as their layout,
 * the colour animation as the previs video, and the depth animation of the set and of the people who walk as the
 * control video of the shot's clip: the others are left out, so the clip draws their poses from its keyframe.
 */
async function exportShot(scene: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal, settings: SceneSettings, walkers: string[]) {
  const lighting = getSceneLighting(scene);
  const anchor = anchorSchema.parse({ ...plan.cameraFrames[0]!.view, time: 0 });
  const layout = await renderImage(scene, anchor, aspect, 0, signal, plan, lighting, settings, "color");
  const video = await renderVideo(scene, plan, aspect, signal, () => {}, lighting, settings, "color");
  const people = new Set(scene.objectList.filter(object => object.objType === "cylinder" && !walkers.includes(object.name ?? "")).map(object => object.threeJsonId));
  const walking = { ...plan, tracks: plan.tracks.filter(track => !people.has(track.objectId)) };
  const control = { ...scene, objectList: scene.objectList.filter(object => !people.has(object.threeJsonId)) };
  const depthVideo = await renderVideo(control, walking, aspect, signal, () => {}, lighting, settings, "depth");
  return { layout, video, depthVideo };
}

/**
 * The film's previs plan, every shot's framed plan, the measured blocking of each shot's opening as text for keyframe
 * prompts, and who each shot shows, in its opening and at any moment, for the keyframe and the clip to name, with where
 * each of them looks, who walks during the shot, and where each of them is (`support`: the seat or bed they are on).
 */
export type PrevisPlan = { spec: PrevisSpec; plans: SavedPlan[]; blocking: string[]; timeline: string[]; framed: { opening: string[]; shown: string[]; gaze: Record<string, string>; directions: Record<string, string>; looks: Record<string, string>; walkers: string[]; bodies: Record<string, { support?: string }>; camera: { aspect: number; frames: { time: number; position: { x: number; y: number; z: number }; target: { x: number; y: number; z: number }; fov: number }[] } }[] };

/**
 * Plans the previs of every shot without a person: the director model writes one plan for the whole film (the set,
 * where people are and move, the camera's side, angle and move) and code builds the set, stages each shot from where
 * the previous one ended, frames the camera from the shot size, checks the framing, describes the blocking and finds
 * who is in frame. A plan that shows someone's face too small for the video model to draw, or someone covering another
 * at any moment, or cannot be staged, is sent back with the reason, at most twice. The usable plan with fewer soft
 * problems is kept. Nothing is rendered, so the texts written from the
 * blocking need not wait for the renders. `onStep` is called after each reply of the director model, for a caller that
 * watches for progress.
 */
export async function planPrevis(options: {
  generate: Generate; providerId: string; modelId: string; shots: (SpecShot & { size: string })[]; aspect: number; signal: AbortSignal; onStep?: () => void;
}): Promise<PrevisPlan> {
  const advice = "Where a face is too small, bring those people nearer to each other and to the camera's side for as long as they are in frame: someone far off can start nearer, or walk up before the moment the face matters. Where someone covers another, send them to a place beside the others, never between the camera and them. Shot sizes come from the shot list and stay as they are.";
  const prompt = previsSpecPrompt(options.shots);
  let request = prompt;
  let best: Awaited<ReturnType<typeof stagePlan>> | undefined;
  for (let fixes = 2; ; fixes--) {
    options.signal.throwIfAborted();
    const reply = ((await options.generate({ providerId: options.providerId, modelId: options.modelId, prompt: request, signal: options.signal, responseSchema: previsSpecJsonSchema }) as { text?: string }).text ?? "");
    options.onStep?.();
    const read = readPrevisSpec(reply, options.shots);
    let problems = read.problems;
    if (read.spec && !problems.length) {
      try {
        const staged = await stagePlan(read.spec, options);
        if (!staged.problems.length) return staged.plan;
        if (!best || staged.problems.length <= best.problems.length) best = staged;
        problems = [...staged.problems, advice];
      } catch (error) {
        options.signal.throwIfAborted();
        problems = [error instanceof Error ? error.message : String(error), "Adjust actor facing, placement or camera side to satisfy the required opening gaze without obstruction. Preserve the requested cast, shot sizes and gaze."];
      }
    }
    console.warn("The previs plan needs fixing", problems);
    if (!fixes) {
      if (best) return best.plan;
      throw new Error(`The previs plan cannot be used: ${problems.join(" ")}`);
    }
    request = `${prompt}\n\nYour plan:\n${reply}\n\nIt cannot be used yet. Output the whole JSON again with these fixed:\n${problems.map(problem => `- ${problem}`).join("\n")}`;
  }
}

/** Stages, frames and checks every shot of a previs spec; `problems` lists the faces too small and the people covered, by shot. */
async function stagePlan(spec: PrevisSpec, options: { shots: (SpecShot & { size: string })[]; aspect: number; signal: AbortSignal }) {
  const scene = buildSet(spec);
  const ceiling = ceilingOf(spec);
  const plans: SavedPlan[] = [];
  const blocking: string[] = [];
  const framed: PrevisPlan["framed"] = [];
  const timeline: string[] = [];
  const problems: string[] = [];
  for (const [index, staged] of stageShots(spec, options.shots).entries()) {
    const { shot, seconds, tracks, subjects, camera } = staged;
    timeline.push(staged.timeline);
    options.signal.throwIfAborted();
    const size = options.shots[index]!.size;
    const base: DirectorPlan = { name: `Shot ${shot}`, duration: seconds, tracks, cameraFrames: [{ time: 0, easing: "smooth", view: emptyShotView(spec) }] };
    const angled = camera.angle !== "eye";
    // Over a shoulder, the frame cuts the person in front on purpose, so only the people looked at are checked.
    let checked = subjects.filter(name => name !== camera.over);
    let plan = await frameShot(scene, base, options.aspect, subjects, size, camera, ceiling, options.shots[index]!.gaze);
    let issues = await framingIssues(scene, plan, options.aspect, checked, angled);
    // An over-the-shoulder view or a camera move that fails falls back to a held camera on the same side.
    if (issues.hard.length && (camera.over || camera.move !== "static")) {
      checked = subjects;
      plan = await frameShot(scene, base, options.aspect, subjects, size, { ...camera, over: undefined, move: "static" }, ceiling, options.shots[index]!.gaze);
      issues = await framingIssues(scene, plan, options.aspect, checked, angled);
    }
    if (issues.hard.length) throw new Error(`Shot ${shot}: ${issues.hard.join(" ")}`);
    if (issues.overlap.length) console.warn(`Shot ${shot}: kept with people overlapping`, issues.overlap);
    const found = [...await smallFaces(scene, plan, options.aspect, checked, size), ...await coveredPeople(scene, plan, options.aspect, checked)];
    problems.push(...found.map(problem => `Shot ${shot}: ${problem}`));
    plans.push({ ...plan, id: crypto.randomUUID() });
    blocking.push(await describeBlocking(scene, plan, options.aspect, true));
    const people = await framedPeople(scene, plan, options.aspect);
    // Independent head/eye gaze comes from the shot contract, not from the coarse body heading.
    framed.push({ ...people, camera: { aspect: options.aspect, frames: plan.cameraFrames.map(frame => ({ time: frame.time, position: frame.view.camera.position, target: frame.view.controls.target, fov: frame.view.camera.fov })) }, walkers: staged.walkers, bodies: Object.fromEntries([...staged.opening].map(([name, body]) => [name, { support: body.seat?.prop }])) });
  }
  return { plan: { spec, plans, blocking, timeline, framed } as PrevisPlan, problems };
}

/**
 * Renders the shots of a previs plan in order, skipping the `rendered` ones, so a stopped run carries on after them.
 * People are columns of one size, placed by code, which never poses them.
 */
export async function renderPrevis(options: {
  plan: Pick<PrevisPlan, "spec" | "plans">; shots: SpecShot[]; rendered: number[]; aspect: number; signal: AbortSignal;
  onShot: (result: { shot: number; layout: Blob; video: Blob; depthVideo: Blob }) => Promise<void>;
}) {
  const { spec, plans } = options.plan;
  const scene = buildSet(spec);
  for (const [index, staged] of stageShots(spec, options.shots).entries()) {
    if (options.rendered.includes(staged.shot)) continue;
    options.signal.throwIfAborted();
    const plan = plans[index]!;
    const exported = await exportShot(scene, plan, options.aspect, options.signal, renderSettings(spec), staged.walkers);
    await options.onShot({ shot: staged.shot, ...exported });
  }
}
