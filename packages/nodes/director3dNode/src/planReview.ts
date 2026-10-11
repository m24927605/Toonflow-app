import { Box3, Mesh, Vector3, type Object3D } from "three";
import { getObjectByThreeJsonId } from "threejson/core";
import { createStage, disposeStage, type SceneDocument } from "./scene";
import { prepareMotion, sampleMotion } from "./motion";
import { prepareSceneAnimation, type DirectorPlan } from "./sceneAnimation";

export type PlanIssue = { time: number; message: string };
type Collider = { label: string; owner: string; object: Object3D; moving: boolean; box: Box3; start: Box3 };

const frameRate = 30;
const gap = 1e-3;
// Short shots fail cheaply and keep generated motion stable; most shots of a well-paced AI short stay within 8 s.
export const maxShotSeconds = 8;

/** Shots are the spans between the plan start, every cut and the plan end. */
export function shotSpans(plan: Pick<DirectorPlan, "duration" | "cameraFrames">) {
  const cuts = plan.cameraFrames.filter(frame => frame.easing === "cut" && frame.time > 0 && frame.time < plan.duration).map(frame => frame.time);
  const bounds = [0, ...cuts, plan.duration];
  return bounds.slice(1).map((end, index) => ({ start: bounds[index]!, end }));
}

/** Messages for shots longer than {@link maxShotSeconds}. */
export function longShotIssues(plan: Pick<DirectorPlan, "duration" | "cameraFrames">): PlanIssue[] {
  return shotSpans(plan).flatMap(({ start, end }, index) => end - start > maxShotSeconds + 1e-6
    ? [{ time: start, message: `Shot ${index + 1} runs ${(end - start).toFixed(1)} s, over ${maxShotSeconds} s; split it with a cut` }]
    : []);
}

function overlaps(a: Box3, b: Box3) {
  return Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x) > gap
    && Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y) > gap
    && Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > gap;
}

/**
 * Steps the plan at the export frame rate and reports physical goofs before a video is exported.
 * ACT: Uses axis-aligned boxes per object (per body part for mannequins) and only reports contacts that appear during
 * the plan, so parts built to overlap (a wing through a fuselage) stay silent. Static intrusions present from the first
 * frame and mannequin self-intersection are not detected; they need mesh-level tests (for example three-mesh-bvh).
 */
export async function reviewPlan(scene: SceneDocument, plan: DirectorPlan, aspect: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, aspect);
  const player = prepareSceneAnimation(runtime, plan);
  try {
    const movingIds = new Set(plan.tracks.map(track => track.objectId));
    const colliders: Collider[] = scene.objectList.flatMap(item => {
      const root = getObjectByThreeJsonId(item.threeJsonId, runtime.scene);
      // Zero-thickness planes (water, ground) and hidden props cannot be hit.
      if (!root || item.objType === "plane") return [];
      const label = item.name || item.threeJsonId;
      const moving = movingIds.has(item.threeJsonId);
      const parts: Object3D[] = item.objType === "mannequin" ? root.children.flatMap(function meshes(child): Object3D[] {
        return [...(child instanceof Mesh ? [child] : []), ...child.children.flatMap(meshes)];
      }) : [root];
      return parts.map(object => ({ label, owner: item.threeJsonId, object, moving, box: new Box3(), start: new Box3() }));
    });
    const cameraFrames = prepareMotion(plan.cameraFrames);
    const issues: PlanIssue[] = longShotIssues(plan);
    const reported = new Set<string>();
    const report = (key: string, time: number, message: string) => {
      if (reported.has(key)) return;
      reported.add(key);
      issues.push({ time, message });
    };
    const centers = new Map<string, Vector3[]>();
    const total = Math.max(1, Math.round(plan.duration * frameRate));
    for (let index = 0; index <= total; index++) {
      if (index % 30 === 0) signal.throwIfAborted();
      const time = Math.min(plan.duration, index / frameRate);
      player.setTime(time);
      sampleMotion(runtime.camera, cameraFrames, time);
      runtime.scene.updateMatrixWorld(true);
      for (const collider of colliders) {
        if (index && !collider.moving) continue;
        collider.box.setFromObject(collider.object);
        if (!index) collider.start.copy(collider.box);
      }
      for (const [aIndex, a] of colliders.entries()) {
        if (!index || !a.moving) continue;
        for (const [bIndex, b] of colliders.entries()) {
          if (a.owner === b.owner || (b.moving && bIndex < aIndex) || a.box.isEmpty() || b.box.isEmpty()) continue;
          if (overlaps(a.box, b.box) && !overlaps(a.start, b.start)) report(`hit:${[a.owner, b.owner].sort().join()}`, time, `${a.label} 与 ${b.label} 发生碰撞或穿模`);
        }
      }
      const camera = runtime.camera.position;
      for (const collider of colliders) {
        if (!collider.box.isEmpty() && collider.box.containsPoint(camera)) report(`camera:${collider.owner}`, time, `镜头进入了 ${collider.label} 内部`);
      }
      for (const id of movingIds) {
        const root = getObjectByThreeJsonId(id, runtime.scene);
        if (root) (centers.get(id) ?? centers.set(id, []).get(id)!).push(root.getWorldPosition(new Vector3()));
      }
    }
    // A single-frame jump far beyond the object's usual per-frame travel reads as a teleport on screen.
    for (const [id, points] of centers) {
      const steps = points.slice(1).map((point, index) => point.distanceTo(points[index]!));
      const moving = steps.filter(step => step > 1e-6).sort((a, b) => a - b);
      const typical = moving[Math.floor(moving.length / 2)] ?? 0;
      const jump = steps.findIndex(step => step > gap && step > typical * 8);
      const item = scene.objectList.find(object => object.threeJsonId === id);
      if (jump >= 0) issues.push({ time: (jump + 1) / frameRate, message: `${item?.name || id} 在一帧内瞬移` });
    }
    return issues.sort((a, b) => a.time - b.time);
  } finally {
    player.dispose();
    disposeStage(runtime);
  }
}
