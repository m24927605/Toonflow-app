import { Box3, Raycaster, Vector3, type Object3D } from "three";
import { getObjectByThreeJsonId } from "threejson/core";
import { t } from "@toonflow/i18n/vue";
import { createStage, disposeStage, type SceneDocument } from "./scene";
import { prepareSceneAnimation, type DirectorPlan } from "./sceneAnimation";
import { prepareMotion, sampleMotion } from "./motion";

// People are blocked as cylinders, or as mannequins when the user allows them.
const personTypes = new Set(["cylinder", "capsule", "mannequin"]);

/**
 * Describes where each person stands in the opening frame of a plan and where the camera is, measured in the scene, so
 * text-only models and keyframe prompts can follow the previs without seeing it: the side of the frame, the distance
 * from the camera, and the camera's height and tilt.
 */
export async function describeBlocking(scene: SceneDocument, plan: DirectorPlan, aspect: number) {
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, aspect);
  const player = prepareSceneAnimation(runtime, plan);
  try {
    player.setTime(0);
    const camera = runtime.camera;
    sampleMotion(camera, prepareMotion(plan.cameraFrames), 0);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const metres = (value: number) => Number(value.toFixed(1));
    const lines = scene.objectList.filter(object => personTypes.has(object.objType)).flatMap(object => {
      const root = getObjectByThreeJsonId(object.threeJsonId, runtime.scene);
      if (!root) return [];
      root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(root);
      const centre = box.getCenter(new Vector3());
      const distance = metres(camera.position.distanceTo(centre));
      // The head decides whether and where a person is in frame: a close-up leaves the middle of the body out.
      const point = new Vector3(centre.x, box.min.y + (box.max.y - box.min.y) * 0.9, centre.z).project(camera);
      if (point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) return [t`${object.name}: out of frame`];
      if (point.x < -1 / 3) return [t`${object.name}: left of the frame, about ${distance} m from the camera`];
      if (point.x > 1 / 3) return [t`${object.name}: right of the frame, about ${distance} m from the camera`];
      return [t`${object.name}: centre of the frame, about ${distance} m from the camera`];
    });
    const tilt = Math.asin(camera.getWorldDirection(new Vector3()).y) * 180 / Math.PI;
    const height = metres(camera.position.y);
    lines.push(tilt < -10 ? t`camera about ${height} m high, looking down` : tilt > 10 ? t`camera about ${height} m high, looking up` : t`camera about ${height} m high, level`);
    return lines.join("; ");
  } finally {
    player.dispose();
    disposeStage(runtime);
  }
}

// Heights along a person's cylinder, as fractions of it, that a ray from the camera checks: chest, head and knees.
const sightHeights = [0.6, 0.9, 0.3];
// The nearest a camera may come to a person's surface, in metres: about where a lens frames a tight close-up.
const minimumGap = 0.5;
// How far down each person a shot size frames, as a fraction of their height from the feet; an unrecognised size
// frames everyone whole.
const shotSizes = [
  { pattern: /extreme close|特寫|特写|大特/i, lowest: 0.75 },
  { pattern: /medium close|close|近景|中近/i, lowest: 0.6 },
  { pattern: /medium|mid|中景/i, lowest: 0.4 },
];
// The share of the frame, from its centre, that the framed people must stay within.
const safeArea = 0.9;

/** The stage of a plan's scene with what the framing checks need: each object's root, and who a ray hits first. */
async function framingStage(scene: SceneDocument, plan: DirectorPlan, aspect: number) {
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, aspect);
  const player = prepareSceneAnimation(runtime, plan);
  const camera = runtime.camera;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  const roots = scene.objectList.flatMap(object => {
    const root = getObjectByThreeJsonId(object.threeJsonId, runtime.scene);
    return root ? [{ object, root }] : [];
  });
  const ownerOf = (hit: Object3D) => roots.find(({ root }) => { let node: Object3D | null = hit; while (node && node !== root) node = node.parent; return node === root; })?.object;
  const raycaster = new Raycaster();
  /** The object in front of a person from a camera position, when every sight line to them is blocked. */
  const blockerOf = (from: Vector3, person: (typeof roots)[number]) => {
    const box = new Box3().setFromObject(person.root);
    const centre = box.getCenter(new Vector3());
    const blockers = sightHeights.map(fraction => {
      const target = new Vector3(centre.x, box.min.y + (box.max.y - box.min.y) * fraction, centre.z);
      raycaster.set(from, target.clone().sub(from).normalize());
      raycaster.far = from.distanceTo(target);
      const first = raycaster.intersectObjects(roots.map(item => item.root), true).map(hit => ownerOf(hit.object)).find(Boolean);
      return first && first !== person.object ? first : undefined;
    });
    return blockers.every(Boolean) ? blockers[0] : undefined;
  };
  /** Poses the people and the camera at a time of the plan. */
  const pose = (time: number, motion = prepareMotion(plan.cameraFrames)) => {
    player.setTime(time);
    sampleMotion(camera, motion, time);
    camera.updateMatrixWorld();
    runtime.scene.updateMatrixWorld(true);
  };
  const dispose = () => {
    player.dispose();
    disposeStage(runtime);
  };
  return { camera, roots, blockerOf, pose, dispose };
}

/**
 * Checks that every person a shot names is in frame and not hidden at each camera keyframe, by rays from the camera to
 * points up their cylinder against everything in the scene, so a director agent that cannot see the render can fix a
 * camera behind a wall or inside a prop. Returns the problems in words for the agent; none when the framing holds.
 */
export async function framingIssues(scene: SceneDocument, plan: DirectorPlan, aspect: number, cast: string[]) {
  const people = scene.objectList.filter(object => personTypes.has(object.objType));
  const missing = cast.filter(name => !people.some(object => object.name === name));
  if (missing.length) return [`The scene has no person cylinder named ${missing.join(", ")}; name each person's cylinder exactly as the shot list does.`];
  const stage = await framingStage(scene, plan, aspect);
  try {
    const { camera } = stage;
    const motion = prepareMotion(plan.cameraFrames);
    const issues: string[] = [];
    for (const time of new Set(plan.cameraFrames.map(frame => frame.time))) {
      stage.pose(time, motion);
      for (const name of cast) {
        const person = stage.roots.find(({ object }) => object.name === name);
        if (!person) continue;
        const box = new Box3().setFromObject(person.root);
        const centre = box.getCenter(new Vector3());
        // The head is what every shot size keeps in frame; a close-up leaves the middle of the body out.
        const head = new Vector3(centre.x, box.min.y + (box.max.y - box.min.y) * 0.9, centre.z).project(camera);
        if (head.z > 1 || Math.abs(head.x) > 1 || Math.abs(head.y) > 1) {
          issues.push(`At ${time} s ${name}'s head is out of frame.`);
          continue;
        }
        // A cylinder seen from closer than a lens ever is fills the frame with one grey surface and shows no framing.
        const gap = Math.hypot(camera.position.x - centre.x, camera.position.z - centre.z) - (box.max.x - box.min.x) / 2;
        if (gap < minimumGap) issues.push(`At ${time} s the camera is ${Math.max(0, gap).toFixed(2)} m from ${name}; keep it at least ${minimumGap} m away, even for a close-up.`);
        const blocker = stage.blockerOf(camera.position, person);
        if (blocker) issues.push(`At ${time} s ${name} is hidden from the camera behind ${blocker.name || blocker.threeJsonId}.`);
      }
    }
    return issues;
  } finally {
    stage.dispose();
  }
}

/**
 * Frames a shot's people by computation when the agent cannot: at every camera keyframe the camera keeps the side it
 * looks from, aims level at the people, and steps back until the part of each person the shot size shows (with their
 * width) projects inside the safe area; it swings round them in 30° steps until nothing is in the way. Lens and timing
 * are kept.
 * ACT: Every keyframe is framed on its own, so a push-in or pull-out is flattened to one distance; scale the distances
 * by the agent's original ratios if moves need to survive.
 */
export async function reframeShot(scene: SceneDocument, plan: DirectorPlan, aspect: number, cast: string[], size: string): Promise<DirectorPlan> {
  const stage = await framingStage(scene, plan, aspect);
  try {
    const people = cast.flatMap(name => stage.roots.filter(({ object }) => object.name === name && personTypes.has(object.objType)));
    if (!people.length) return plan;
    const motion = prepareMotion(plan.cameraFrames);
    const lowest = shotSizes.find(rule => rule.pattern.test(size))?.lowest ?? 0;
    const { camera } = stage;
    const cameraFrames = plan.cameraFrames.map(frame => {
      stage.pose(frame.time, motion);
      const boxes = people.map(person => new Box3().setFromObject(person.root));
      // The top of each person and the lowest point the shot size shows, on their axis.
      const marks = boxes.flatMap(box => {
        const centre = box.getCenter(new Vector3());
        const height = box.max.y - box.min.y;
        return [box.max.y, box.min.y + height * lowest].map(y => ({ point: new Vector3(centre.x, y, centre.z), radius: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2 }));
      });
      const target = marks.reduce((sum, mark) => sum.add(mark.point), new Vector3()).divideScalar(marks.length);
      const nearest = Math.max(...marks.map(mark => mark.radius + mark.point.clone().setY(target.y).distanceTo(target))) + minimumGap;
      camera.fov = frame.view.camera.fov;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      // Whether every mark, widened by its person's radius across the view, projects inside the safe area.
      const fits = (from: Vector3) => {
        camera.position.copy(from);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
        return marks.every(({ point, radius }) => [-radius, radius].every(offset => {
          const projected = point.clone().addScaledVector(right, offset).project(camera);
          return projected.z < 1 && Math.abs(projected.x) <= safeArea && Math.abs(projected.y) <= safeArea;
        }));
      };
      const side = new Vector3(frame.view.camera.position.x - target.x, 0, frame.view.camera.position.z - target.z);
      if (side.lengthSq() < 1e-6) side.set(0, 0, 1);
      side.normalize();
      const turns = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6];
      const candidates = turns.map(turn => {
        const direction = side.clone().applyAxisAngle(new Vector3(0, 1, 0), turn * Math.PI / 6);
        let distance = nearest;
        while (distance < 60 && !fits(target.clone().addScaledVector(direction, distance))) distance *= 1.05;
        return target.clone().addScaledVector(direction, distance);
      });
      const position = candidates.find(from => people.every(person => !stage.blockerOf(from, person))) ?? candidates[0]!;
      return {
        ...frame,
        view: {
          ...frame.view,
          camera: { ...frame.view.camera, position: { x: position.x, y: position.y, z: position.z } },
          controls: { ...frame.view.controls, target: { x: target.x, y: target.y, z: target.z } },
        },
      };
    });
    return { ...plan, cameraFrames };
  } finally {
    stage.dispose();
  }
}
