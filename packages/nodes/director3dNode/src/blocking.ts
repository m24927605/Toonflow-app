import { Box3, Raycaster, Vector3, type Object3D, type PerspectiveCamera } from "three";
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
 * from the camera, which way people sharing the frame face, and the camera's height and tilt.
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
    const people = scene.objectList.filter(object => personTypes.has(object.objType)).flatMap(object => {
      const root = getObjectByThreeJsonId(object.threeJsonId, runtime.scene);
      if (!root) return [];
      root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(root);
      const centre = box.getCenter(new Vector3());
      // The head decides whether and where a person is in frame: a close-up leaves the middle of the body out.
      const point = new Vector3(centre.x, box.min.y + (box.max.y - box.min.y) * 0.9, centre.z).project(camera);
      return [{ name: object.name, centre, point, framed: point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 }];
    });
    const lines = people.map(({ name, centre, point, framed }) => {
      const distance = metres(camera.position.distanceTo(centre));
      if (!framed) return t`${name}: out of frame`;
      if (point.x < -1 / 3) return t`${name}: left of the frame, about ${distance} m from the camera`;
      if (point.x > 1 / 3) return t`${name}: right of the frame, about ${distance} m from the camera`;
      return t`${name}: centre of the frame, about ${distance} m from the camera`;
    });
    // ACT: A cylinder has no front, so people sharing the frame are taken to face the nearest other one, as in most
    // two-shots; people who look elsewhere, at a view or a screen, are told the wrong way. Letting the director agent
    // turn each person and reading the turn here would lift that.
    const framed = people.filter(person => person.framed);
    const level = (vector: Vector3) => vector.setY(0).normalize();
    for (const person of framed) {
      const other = framed.filter(item => item !== person).sort((a, b) => a.centre.distanceTo(person.centre) - b.centre.distanceTo(person.centre))[0];
      if (!other) continue;
      const angle = level(other.centre.clone().sub(person.centre)).angleTo(level(camera.position.clone().sub(person.centre))) * 180 / Math.PI;
      lines.push(angle < 30 ? t`${person.name} faces ${other.name}, towards the camera`
        : angle < 75 ? t`${person.name} faces ${other.name}, seen in three-quarter view`
          : angle < 120 ? t`${person.name} faces ${other.name}, seen in profile`
            : t`${person.name} faces ${other.name}, seen from behind`);
    }
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
// Size names are matched in English and Chinese: "\u7279\u5beb"/"\u7279\u5199" and "\u5927\u7279" (close-up, extreme
// close-up), "\u8fd1\u666f" and "\u4e2d\u8fd1" (medium close-up), "\u4e2d\u666f" (medium shot).
const shotSizes = [
  { pattern: /extreme close|\u7279\u5beb|\u7279\u5199|\u5927\u7279/i, lowest: 0.75 },
  { pattern: /medium close|close|\u8fd1\u666f|\u4e2d\u8fd1/i, lowest: 0.6 },
  { pattern: /medium|mid|\u4e2d\u666f/i, lowest: 0.4 },
];
// The share of the frame, from its centre, that the framed people must stay within.
const safeArea = 0.9;
// Camera heights in metres a shot keeps unless the shot list asks for a low or high angle; computed framing stays at
// the lower bound or above.
const cameraHeights = { lowest: 0.5, highest: 2.5, framed: 0.6 };
// Two people sharing more than this part of the smaller one's screen area read as one shape.
const overlapLimit = 0.5;
// Cylinder heights in metres that a seated or standing person's opening pose takes.
const postureHeights = { seated: 1.3, standing: 1.4 };

export type Posture = "seated" | "standing";

/** The rectangle a box covers on screen, in normalised device coordinates clipped to the frame; empty when off screen. */
function screenRect(box: Box3, camera: PerspectiveCamera) {
  const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => new Vector3(x ? box.max.x : box.min.x, y ? box.max.y : box.min.y, z ? box.max.z : box.min.z).project(camera))));
  const clip = (value: number) => Math.max(-1, Math.min(1, value));
  const xs = corners.map(point => clip(point.x)), ys = corners.map(point => clip(point.y));
  return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys) };
}

/** The share of the smaller rectangle that two screen rectangles have in common. */
function overlapShare(a: ReturnType<typeof screenRect>, b: ReturnType<typeof screenRect>) {
  const common = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom));
  const area = (rect: typeof a) => (rect.right - rect.left) * (rect.top - rect.bottom);
  return common / Math.max(1e-6, Math.min(area(a), area(b)));
}

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
 * Checks a shot's framing at each camera keyframe, so a director agent that cannot see the render can fix it: every
 * person the shot names has their head in frame, is not too close, is not hidden behind anything (rays from the camera
 * to points up their cylinder) and does not cover another; the camera stands at a usual height unless the shot list
 * asks for a low or high angle (`angled`). `hard` problems fail the shot. `soft` ones are only handed back to the agent:
 * a cylinder whose height does not fit the posture the shot list gives (`postures`).
 */
export async function framingIssues(scene: SceneDocument, plan: DirectorPlan, aspect: number, cast: string[], angled = false, postures: Record<string, Posture> = {}) {
  const people = scene.objectList.filter(object => personTypes.has(object.objType));
  const missing = cast.filter(name => !people.some(object => object.name === name));
  if (missing.length) return { hard: [`The scene has no person cylinder named ${missing.join(", ")}; name each person's cylinder exactly as the shot list does.`], soft: [] };
  const stage = await framingStage(scene, plan, aspect);
  try {
    const { camera } = stage;
    const motion = prepareMotion(plan.cameraFrames);
    const hard: string[] = [];
    const soft: string[] = [];
    const named = cast.flatMap(name => stage.roots.filter(({ object }) => object.name === name));
    stage.pose(0, motion);
    for (const person of named) {
      const posture = postures[person.object.name!];
      const box = new Box3().setFromObject(person.root);
      const height = box.max.y - box.min.y;
      if (posture === "seated" && height > postureHeights.seated) soft.push(`${person.object.name} is seated at the start of this shot, but their cylinder is ${height.toFixed(1)} m tall; make it about 1.0 m.`);
      if (posture === "standing" && height < postureHeights.standing) soft.push(`${person.object.name} is standing at the start of this shot, but their cylinder is ${height.toFixed(1)} m tall; make it about 1.7 m.`);
    }
    for (const time of new Set(plan.cameraFrames.map(frame => frame.time))) {
      stage.pose(time, motion);
      if (!angled && (camera.position.y < cameraHeights.lowest || camera.position.y > cameraHeights.highest)) {
        hard.push(`At ${time} s the camera is ${camera.position.y.toFixed(2)} m high; keep it between ${cameraHeights.lowest} and ${cameraHeights.highest} m, as the shot list asks for no low or high angle.`);
      }
      const rects: { name: string; rect: ReturnType<typeof screenRect> }[] = [];
      for (const person of named) {
        const name = person.object.name!;
        const box = new Box3().setFromObject(person.root);
        const centre = box.getCenter(new Vector3());
        // The head is what every shot size keeps in frame; a close-up leaves the middle of the body out.
        const head = new Vector3(centre.x, box.min.y + (box.max.y - box.min.y) * 0.9, centre.z).project(camera);
        if (head.z > 1 || Math.abs(head.x) > 1 || Math.abs(head.y) > 1) {
          hard.push(`At ${time} s ${name}'s head is out of frame.`);
          continue;
        }
        // A cylinder seen from closer than a lens ever is fills the frame with one grey surface and shows no framing.
        const gap = Math.hypot(camera.position.x - centre.x, camera.position.z - centre.z) - (box.max.x - box.min.x) / 2;
        if (gap < minimumGap) hard.push(`At ${time} s the camera is ${Math.max(0, gap).toFixed(2)} m from ${name}; keep it at least ${minimumGap} m away, even for a close-up.`);
        const blocker = stage.blockerOf(camera.position, person);
        if (blocker) hard.push(`At ${time} s ${name} is hidden from the camera behind ${blocker.name || blocker.threeJsonId}.`);
        rects.push({ name, rect: screenRect(box, camera) });
      }
      for (const [index, a] of rects.entries()) {
        for (const b of rects.slice(index + 1)) {
          if (overlapShare(a.rect, b.rect) > overlapLimit) hard.push(`At ${time} s ${a.name} and ${b.name} overlap in frame; place them or the camera so both are seen apart.`);
        }
      }
    }
    return { hard, soft };
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
      // The camera stays level with the people, raised to a usual height when they are low, such as seated on the floor.
      const at = (direction: Vector3, distance: number) => {
        const from = target.clone().addScaledVector(direction, distance);
        from.y = Math.max(from.y, cameraHeights.framed);
        return from;
      };
      const candidates = turns.map(turn => {
        const direction = side.clone().applyAxisAngle(new Vector3(0, 1, 0), turn * Math.PI / 6);
        let distance = nearest;
        while (distance < 60 && !fits(at(direction, distance))) distance *= 1.05;
        return at(direction, distance);
      });
      const apart = (from: Vector3) => {
        camera.position.copy(from);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        const rects = boxes.map(box => screenRect(box, camera));
        return rects.every((a, index) => rects.slice(index + 1).every(b => overlapShare(a, b) <= overlapLimit));
      };
      const clear = (from: Vector3) => people.every(person => !stage.blockerOf(from, person));
      const position = candidates.find(from => clear(from) && apart(from)) ?? candidates.find(clear) ?? candidates[0]!;
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
