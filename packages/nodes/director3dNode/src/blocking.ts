import { Box3, Raycaster, Vector3, type Object3D, type PerspectiveCamera } from "three";
import { getObjectByThreeJsonId } from "threejson/core";
import { t } from "@toonflow/i18n/vue";
import { createStage, disposeStage, type SceneDocument } from "./scene";
import { prepareSceneAnimation, type DirectorPlan } from "./sceneAnimation";
import { prepareMotion, sampleMotion } from "./motion";

// People are blocked as cylinders, or as mannequins when the user allows them.
const personTypes = new Set(["cylinder", "capsule", "mannequin"]);
// The head decides where a person is in frame: a close-up leaves the middle of the body out.
const headPoint = (box: Box3, camera: PerspectiveCamera) => new Vector3((box.min.x + box.max.x) / 2, box.min.y + (box.max.y - box.min.y) * 0.9, (box.min.z + box.max.z) / 2).project(camera);
const inFrame = (point: Vector3) => point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
/**
 * Whether any of a person is in frame: their head, or else part of their body in front of the camera, such as the
 * shoulder an over-the-shoulder shot looks past, whose head the frame cuts off.
 */
function framedBy(box: Box3, camera: PerspectiveCamera) {
  if (inFrame(headPoint(box, camera))) return true;
  const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => new Vector3(x ? box.max.x : box.min.x, y ? box.max.y : box.min.y, z ? box.max.z : box.min.z).project(camera))))
    .filter(point => Math.abs(point.z) <= 1);
  if (!corners.length) return false;
  const xs = corners.map(point => point.x), ys = corners.map(point => point.y);
  return Math.max(...xs) > -1 && Math.min(...xs) < 1 && Math.max(...ys) > -1 && Math.min(...ys) < 1;
}

/**
 * Describes where each person stands in the opening frame of a plan and where the camera is, measured in the scene, so
 * text-only models and keyframe prompts can follow the previs without seeing it: the side of the frame, the distance
 * from the camera, which way people sharing the frame face, and the camera's height and tilt. People `turned` the way
 * they look (front along +Z) are read as turned; otherwise each is taken to face the nearest other.
 */
export async function describeBlocking(scene: SceneDocument, plan: DirectorPlan, aspect: number, turned = false) {
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
      // People who have not come in yet wait below the floor.
      if (box.max.y < 0) return [];
      const point = headPoint(box, camera);
      return [{ name: object.name, centre: box.getCenter(new Vector3()), facing: root.getWorldDirection(new Vector3()), point, framed: framedBy(box, camera) }];
    });
    const lines = people.map(({ name, centre, point, framed }) => {
      const distance = metres(camera.position.distanceTo(centre));
      if (!framed) return t`${name}: out of frame`;
      if (point.x < -1 / 3) return t`${name}: left of the frame, about ${distance} m from the camera`;
      if (point.x > 1 / 3) return t`${name}: right of the frame, about ${distance} m from the camera`;
      return t`${name}: centre of the frame, about ${distance} m from the camera`;
    });
    // ACT: A round cylinder has no front, so unless people are turned they are taken to face the nearest other one, as
    // in most two-shots; people who look elsewhere, at a view or a screen, are told the wrong way. Turned people are
    // named facing another only when that one stands within 30 degrees of the way they look.
    const framed = people.filter(person => person.framed);
    const level = (vector: Vector3) => vector.setY(0).normalize();
    for (const person of framed) {
      const toward = (other: (typeof framed)[number]) => level(other.centre.clone().sub(person.centre));
      const others = framed.filter(item => item !== person).sort((a, b) => a.centre.distanceTo(person.centre) - b.centre.distanceTo(person.centre));
      const other = turned ? others.find(item => toward(item).angleTo(level(person.facing.clone())) < Math.PI / 6) : others[0];
      if (!other) continue;
      const angle = (turned ? level(person.facing.clone()) : toward(other)).angleTo(level(camera.position.clone().sub(person.centre))) * 180 / Math.PI;
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

// How often a shot is looked at for people coming into frame, in seconds.
const framedStep = 0.5;

/**
 * Where each person in the opening looks, in English for image and video prompts: at the person they are most turned
 * to (within 60 degrees), in frame or not, or else the way they face as the frame shows it. Image models draw people
 * looking into the lens unless told otherwise. ACT: People are read as turned the way they look, as planPrevis stages
 * them; a shot that wants a look into the lens needs that said in its own description.
 */
function gazeOf(people: { object: { name?: string }; root: Object3D }[], opening: string[], camera: PerspectiveCamera) {
  const level = (vector: Vector3) => vector.setY(0).normalize();
  const placed = people.flatMap(({ object, root }) => {
    const box = new Box3().setFromObject(root);
    return object.name && box.max.y >= 0 ? [{ name: object.name, centre: box.getCenter(new Vector3()), facing: level(root.getWorldDirection(new Vector3())) }] : [];
  });
  const right = level(new Vector3(1, 0, 0).applyQuaternion(camera.quaternion));
  const toCamera = (centre: Vector3) => level(camera.position.clone().sub(centre));
  return Object.fromEntries(placed.filter(person => opening.includes(person.name)).map(person => {
    const angleTo = (item: (typeof placed)[number]) => level(item.centre.clone().sub(person.centre)).angleTo(person.facing);
    const other = placed.filter(item => item !== person && angleTo(item) < Math.PI / 3).sort((a, b) => angleTo(a) - angleTo(b))[0];
    if (other) return [person.name, `looks at ${other.name}${opening.includes(other.name) ? "" : ", who is out of frame"}`];
    const side = person.facing.dot(right);
    if (Math.abs(side) > 0.5) return [person.name, `looks towards the ${side > 0 ? "right" : "left"} of the frame`];
    return [person.name, person.facing.angleTo(toCamera(person.centre)) < Math.PI / 2 ? "looks ahead, past the camera" : "looks away from the camera, into the scene"];
  }));
}

/**
 * Who a plan shows, by name: the people any of whom is in frame in the opening, and everyone who is at any moment of
 * the shot, by the same measure as describeBlocking; and where each person in the opening looks. The shot list's cast cell may leave out someone the
 * camera sees, such as the person a close shot looks past, who is drawn all the same.
 */
export async function framedPeople(scene: SceneDocument, plan: DirectorPlan, aspect: number) {
  const stage = await framingStage(scene, plan, aspect);
  try {
    const people = stage.roots.filter(({ object }) => personTypes.has(object.objType));
    const motion = prepareMotion(plan.cameraFrames);
    const framedAt = (time: number) => {
      stage.pose(time, motion);
      return people.flatMap(({ object, root }) => {
        const box = new Box3().setFromObject(root);
        // People who have not come in yet wait below the floor.
        return object.name && box.max.y >= 0 && framedBy(box, stage.camera) ? [object.name] : [];
      });
    };
    const shown = new Set<string>();
    // The last moment too, where a move or a walk may end on someone.
    for (const time of [...Array.from({ length: Math.floor(plan.duration / framedStep) }, (_, index) => (index + 1) * framedStep), plan.duration]) {
      for (const name of framedAt(time)) shown.add(name);
    }
    const opening = framedAt(0);
    for (const name of opening) shown.add(name);
    return { opening, shown: [...shown], gaze: gazeOf(people, opening, stage.camera) };
  } finally {
    stage.dispose();
  }
}

/**
 * Checks a shot's framing at each camera keyframe, the floor every computed camera must keep: every person the shot
 * names has their head in frame, is not too close, is not hidden behind anything (rays from the camera to points up
 * their cylinder) and does not cover another; the camera stands at a usual height unless the shot asks for a low or
 * high angle (`angled`). `hard` problems fail the shot. `overlap` (people covering each other) is kept, as people
 * placed close together may overlap from every side.
 */
export async function framingIssues(scene: SceneDocument, plan: DirectorPlan, aspect: number, cast: string[], angled = false) {
  const people = scene.objectList.filter(object => personTypes.has(object.objType));
  const missing = cast.filter(name => !people.some(object => object.name === name));
  if (missing.length) return { hard: [`The scene has no person cylinder named ${missing.join(", ")}; name each person's cylinder exactly as the shot list does.`], overlap: [] };
  const stage = await framingStage(scene, plan, aspect);
  try {
    const { camera } = stage;
    const motion = prepareMotion(plan.cameraFrames);
    const hard: string[] = [];
    const overlap: string[] = [];
    const named = cast.flatMap(name => stage.roots.filter(({ object }) => object.name === name));
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
          if (overlapShare(a.rect, b.rect) > overlapLimit) overlap.push(`At ${time} s ${a.name} and ${b.name} overlap in frame; place them or the camera so both are seen apart.`);
        }
      }
    }
    return { hard, overlap };
  } finally {
    stage.dispose();
  }
}

// Vertical fields of view by the share of a person a shot size leaves out: longer lenses for closer shots.
const lensOf = (lowest: number) => lowest >= 0.6 ? 30 : lowest >= 0.4 ? 36 : 45;
// How much further back a push in starts or a pull out ends.
const moveRatio = 1.3;

export type ShotCamera = { direction: { x: number; z: number }; angle: "eye" | "low" | "high"; move: "static" | "pushIn" | "pullOut" | "follow"; over?: string };

/**
 * Frames a shot by computation: the camera stands on the asked side of the people, level with the part of them the
 * shot size shows (or low, or a metre above it), aims at it, and steps back until all of it is inside the safe area:
 * wherever they move while the camera holds, or for a close shot at its opening, as people may well leave a close-up.
 * When something is in the way it swings round in 30° steps, at most 60° either way so it keeps to its side of the
 * action. A move adds a keyframe at the end: a push in starts further back, a pull out ends there, and a follow frames
 * the people again where they end. Over a shoulder it stands just behind that person at their eye height, looking past
 * them at the others' heads over the shot, on the side `direction` gives. The camera stays below `ceiling`.
 */
export async function frameShot(scene: SceneDocument, plan: DirectorPlan, aspect: number, cast: string[], size: string, shot: ShotCamera, ceiling = Infinity): Promise<DirectorPlan> {
  const stage = await framingStage(scene, plan, aspect);
  try {
    const people = cast.flatMap(name => stage.roots.filter(({ object }) => object.name === name && personTypes.has(object.objType)));
    if (!people.length) return plan;
    const { camera } = stage;
    const end = plan.duration;
    const lowest = shotSizes.find(rule => rule.pattern.test(size))?.lowest ?? 0;
    const fov = lensOf(lowest);
    // Posing a moment also moves the camera to the plan's own, so the lens is set again after every pose.
    const poseAt = (time: number) => {
      stage.pose(time);
      camera.fov = fov;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    };
    const boxesAt = (time: number, of = people) => {
      poseAt(time);
      return of.map(person => new Box3().setFromObject(person.root));
    };
    const below = (y: number) => Math.min(y, ceiling - 0.15);
    const view = (from: Vector3, target: Vector3) => ({
      camera: { position: { x: from.x, y: from.y, z: from.z }, fov, near: 0.1, far: 1000 },
      controls: { target: { x: target.x, y: target.y, z: target.z } },
    });

    const over = shot.over ? stage.roots.find(({ object }) => object.name === shot.over && personTypes.has(object.objType)) : undefined;
    const others = people.filter(person => person !== over);
    if (over && others.length) {
      const near = boxesAt(0, [over])[0]!;
      const far = [0, end / 2, end].flatMap(time => boxesAt(time, others));
      const nearCentre = near.getCenter(new Vector3());
      const farCentre = far.reduce((sum, box) => sum.add(box.getCenter(new Vector3())), new Vector3()).divideScalar(far.length);
      const away = new Vector3(nearCentre.x - farCentre.x, 0, nearCentre.z - farCentre.z).normalize();
      const across = new Vector3(-away.z, 0, away.x);
      if (across.x * shot.direction.x + across.z * shot.direction.z < 0) across.negate();
      const from = new Vector3(nearCentre.x, 0, nearCentre.z).addScaledVector(away, 0.75).addScaledVector(across, 0.4);
      from.y = below(Math.max(cameraHeights.framed, near.max.y - 0.1));
      const heads = far.map(box => box.max.y - 0.15);
      const target = new Vector3(farCentre.x, (Math.min(...heads) + Math.max(...heads)) / 2, farCentre.z);
      return { ...plan, cameraFrames: [{ time: 0, easing: "smooth", view: view(from, target) }] };
    }

    const up = new Vector3(0, 1, 0);
    const side = new Vector3(shot.direction.x, 0, shot.direction.z).normalize();
    /** The camera that frames the people at all of `times`, from the first of `turns` that sees them clearly. */
    const fit = (times: number[], turns = [0, 1, -1, 2, -2]) => {
      const boxes = times.flatMap(time => boxesAt(time));
      // The top of each person and the lowest point the shot size shows, on their axis.
      const marks = boxes.flatMap(box => {
        const centre = box.getCenter(new Vector3());
        const height = box.max.y - box.min.y;
        return [box.max.y, box.min.y + height * lowest].map(y => ({ point: new Vector3(centre.x, y, centre.z), radius: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2 }));
      });
      const target = marks.reduce((sum, mark) => sum.add(mark.point), new Vector3()).divideScalar(marks.length);
      const height = below(shot.angle === "low" ? 0.4 : shot.angle === "high" ? target.y + 1 : Math.max(cameraHeights.framed, target.y));
      const nearest = Math.max(...marks.map(mark => mark.radius + mark.point.clone().setY(target.y).distanceTo(target))) + minimumGap;
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
      const at = (direction: Vector3, distance: number) => target.clone().addScaledVector(direction, distance).setY(height);
      poseAt(times[0]!);
      const candidates = turns.map(turn => {
        const direction = side.clone().applyAxisAngle(up, turn * Math.PI / 6);
        let distance = nearest;
        while (distance < 60 && !fits(at(direction, distance))) distance *= 1.05;
        return { turn, from: at(direction, distance), target };
      });
      // The largest share any two people cover of each other from a camera position.
      const overlapFrom = (from: Vector3) => {
        camera.position.copy(from);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        const rects = people.map(person => screenRect(new Box3().setFromObject(person.root), camera));
        return Math.max(0, ...rects.flatMap((a, index) => rects.slice(index + 1).map(b => overlapShare(a, b))));
      };
      // The asked side unless something hides someone or people cover each other there; then the nearest side that
      // is clear, or the clear side where they cover each other least.
      const clear = candidates.filter(({ from }) => people.every(person => !stage.blockerOf(from, person))).map(item => ({ ...item, overlap: overlapFrom(item.from) }));
      return clear.find(item => item.overlap <= overlapLimit) ?? clear.sort((a, b) => a.overlap - b.overlap)[0] ?? candidates[0]!;
    };
    const backed = (framing: ReturnType<typeof fit>) => {
      const offset = framing.from.clone().sub(framing.target).setY(0).multiplyScalar(moveRatio);
      return { ...framing, from: framing.target.clone().add(offset).setY(framing.from.y) };
    };
    const key = (time: number, framing: ReturnType<typeof fit>) => ({ time, easing: "smooth" as const, view: view(framing.from, framing.target) });
    let cameraFrames: DirectorPlan["cameraFrames"];
    if (shot.move === "follow") {
      const first = fit([0]);
      cameraFrames = [key(0, first), key(end, fit([end], [first.turn]))];
    } else {
      const held = fit(lowest >= 0.6 ? [0] : [0, end / 2, end]);
      cameraFrames = shot.move === "pushIn" ? [key(0, backed(held)), key(end, held)]
        : shot.move === "pullOut" ? [key(0, held), key(end, backed(held))]
          : [key(0, held)];
    }
    return { ...plan, cameraFrames };
  } finally {
    stage.dispose();
  }
}
