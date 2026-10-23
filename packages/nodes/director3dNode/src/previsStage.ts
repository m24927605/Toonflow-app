import { Euler, Matrix4, Vector3 } from "three";
import type { SceneDocument } from "./scene";
import type { DirectorPlan } from "./sceneAnimation";
import { minMoveSeconds, propKinds, type Place as SpecPlace, type Posture, type PrevisSpec, type PropKind, type SpecShot } from "./previsSpec";

/**
 * Builds the set of a previs plan and stages its shots, by computation only: the room and props at real scale, every
 * person as a flattened column at the height of their posture turned the way they look, walks between named places,
 * and which side of the people each shot's camera stands on. Each shot starts from where the previous one left
 * everyone, so nobody jumps between shots. The opening frame can also be posed with jointed figures for the depth map.
 */

type Point = { x: number; z: number };
type Footprint = { name: string; kind: PropKind; centre: Point; facing: Point; width: number; depth: number; height: number; bottom: number; seat?: number };
type Place = Point & { posture: Posture; seat?: { prop: string; height: number; alongX: boolean } };
/** A person at a moment: where, in what posture, turned to `yaw` (radians from +Z), looking at `faces` or the nearest. */
export type StagedBody = Place & { yaw: number; faces?: string };
/** `timeline` says in words who moves when in the shot, for the texts written from the previs to keep its timing. */
export type StagedShot = {
  shot: number; seconds: number; tracks: DirectorPlan["tracks"]; subjects: string[]; opening: Map<string, StagedBody>; timeline: string;
  camera: { direction: Point; angle: "eye" | "low" | "high"; move: "static" | "pushIn" | "pullOut" | "follow"; over?: string };
};

// People are columns as wide as shoulders and about half as deep, so the way they face shows; how far below the floor
// people wait before they enter.
const standingHeight = 1.7;
const radius = 0.22;
const depthRatio = 0.55;
const hiddenDepth = -10;
// The jointed figure's proportions, which the columns follow so both stand equally tall: its height, its hip joint
// above the feet, a 1.7 m person's hip joint above a chair seat and above the floor or a cushion when kneeling (floor
// sitting is taken as kneeling, seiza), the hip joint to the top of the head, and a lying body's middle above its bed.
const figureHeight = 1.8;
const figureHip = 0.91;
const figureScale = standingHeight / figureHeight;
const chairHip = 0.06;
const kneelHip = 0.22;
const upperBody = (figureHeight - figureHip) * figureScale;
const lyingMiddle = 0.12;
// A seat at least this high is sat on like a chair; lower ones are knelt or sat on like the floor.
const chairSeat = 0.3;
// Walking speed in metres a second, the time to sit down or stand up, and the share of a shot the action may take.
const walkSpeed = 1.1;
const postureTime = 1;
const actionShare = 0.9;
// The gap kept around props and between people, in metres.
const clearance = 0.15;
const personGap = 0.55;
const wallHeight = 2.4;
// How far the floor runs on past the room, under a camera that steps out of it.
const floorRunOn = 4;
// How far off the other person's eyeline the camera of a single stands, so the face is seen in three-quarter view.
const eyelineAngle = 35 * Math.PI / 180;

const sideDirections: Record<string, Point> = {
  front: { x: 0, z: 1 }, frontLeft: { x: -Math.SQRT1_2, z: Math.SQRT1_2 }, frontRight: { x: Math.SQRT1_2, z: Math.SQRT1_2 },
  left: { x: -1, z: 0 }, right: { x: 1, z: 0 }, back: { x: 0, z: -1 },
};
const colours = { floor: "#8c8273", walls: ["#b9b3a7", "#aaa498", "#c3bdb1"], ceiling: "#d2cec6", prop: "#6e5c49", flat: "#a69a84", opening: "#c9c1ad", people: ["#d9714e", "#4e8ad9", "#8bc34a", "#e0b84a", "#a46bd9", "#4ec2c2"] };

const add = (a: Point, b: Point, scale = 1) => ({ x: a.x + b.x * scale, z: a.z + b.z * scale });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
const leftOf = (facing: Point) => ({ x: -facing.z, z: facing.x });
// A footprint's extent along x and z: props facing sideways turn their width along z.
const extents = (prop: Footprint) => Math.abs(prop.facing.x) > 0.5 ? { x: prop.depth, z: prop.width } : { x: prop.width, z: prop.depth };
const halfAlong = (prop: Footprint, direction: Point) => (Math.abs(direction.x) * extents(prop).x + Math.abs(direction.z) * extents(prop).z) / 2;
const rectOf = (prop: Footprint, margin: number) => {
  const { x, z } = extents(prop);
  return { minX: prop.centre.x - x / 2 - margin, maxX: prop.centre.x + x / 2 + margin, minZ: prop.centre.z - z / 2 - margin, maxZ: prop.centre.z + z / 2 + margin };
};
type Rect = ReturnType<typeof rectOf>;
/** The middle of a part of the floor: thirds of the room across and deep. */
const roomPoint = (width: number, depth: number, place: string): Point => ({
  x: /left/i.test(place) ? -width / 3 : /right/i.test(place) ? width / 3 : 0,
  z: /back/i.test(place) ? -depth / 3 : /front/i.test(place) ? depth / 3 : 0,
});
// Rugs, mats and cushions are walked and stood on, and doors and windows are panels in the walls: neither is in anyone's
// way, and a flat one is no place another prop has to keep clear of.
const flat = (prop: Footprint) => prop.height <= 0.1;
const opening = (prop: Footprint) => prop.depth < 0.1;
const obstacle = (prop: Footprint) => !flat(prop) && !opening(prop);
const inside = (point: Point, rect: Rect) => point.x > rect.minX && point.x < rect.maxX && point.z > rect.minZ && point.z < rect.maxZ;
const overlaps = (a: Rect, b: Rect) => a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;

/** Whether a straight walk from a to b passes through a rectangle (the slab test; touching a corner does not count). */
function crosses(a: Point, b: Point, rect: Rect) {
  let start = 0, end = 1;
  const dx = b.x - a.x, dz = b.z - a.z;
  for (const [p, q] of [[-dx, a.x - rect.minX], [dx, rect.maxX - a.x], [-dz, a.z - rect.minZ], [dz, rect.maxZ - a.z]] as const) {
    if (Math.abs(p) < 1e-9) {
      if (q <= 0) return false;
      continue;
    }
    const ratio = q / p;
    if (p < 0) start = Math.max(start, ratio);
    else end = Math.min(end, ratio);
    if (start >= end) return false;
  }
  return true;
}

/** The set of a plan: its room, and its props laid out from their places against walls and beside each other. */
function layOut(spec: PrevisSpec) {
  const { interior, width, depth } = spec.set;
  const height = spec.set.height ?? wallHeight;
  const props: Footprint[] = [];
  // Walls in order back, front, left, right: where their surface is and which way they face into the room.
  const walls = [
    { facing: { x: 0, z: 1 }, at: (point: Point) => ({ x: point.x, z: -depth / 2 }) },
    { facing: { x: 0, z: -1 }, at: (point: Point) => ({ x: point.x, z: depth / 2 }) },
    { facing: { x: 1, z: 0 }, at: (point: Point) => ({ x: -width / 2, z: point.z }) },
    { facing: { x: -1, z: 0 }, at: (point: Point) => ({ x: width / 2, z: point.z }) },
  ];
  const wallDistance = (point: Point) => [point.z + depth / 2, depth / 2 - point.z, point.x + width / 2, width / 2 - point.x];
  for (const item of spec.set.props) {
    const kind = propKinds[item.kind] as { size: number[]; wall?: boolean; raised?: number; seat?: number };
    const [propWidth, propDepth, propHeight] = item.size ? [item.size.width, item.size.depth, item.size.height] : kind.size as [number, number, number];
    const prop: Footprint = { name: item.name, kind: item.kind, centre: { x: 0, z: 0 }, facing: { x: 0, z: 1 }, width: propWidth, depth: propDepth, height: propHeight, bottom: kind.raised ?? 0, seat: kind.seat };
    let point: Point;
    let tangent: Point = { x: 1, z: 0 };
    if (typeof item.at === "string") point = roomPoint(width, depth, item.at);
    else {
      const other = props.find(prop => prop.name === (item.at as Exclude<SpecPlace, string>).prop)!;
      const direction = sideOf(other, item.at.side ?? "front");
      prop.facing = other.facing;
      point = add(other.centre, direction, halfAlong(other, direction) + halfAlong(prop, direction) + 0.05);
      tangent = leftOf(direction);
    }
    if (kind.wall && interior) {
      const gaps = wallDistance(point);
      const wall = walls[gaps.indexOf(Math.min(...gaps))]!;
      prop.facing = wall.facing;
      tangent = leftOf(wall.facing);
      point = add(wall.at(point), wall.facing, prop.depth / 2 + (prop.depth < 0.1 ? 0.02 : 0));
    }
    // A prop stays inside the room, and one that lands on another slides along its wall or side until it is clear; with
    // no clear spot within three metres it keeps its place.
    const { x: spanX, z: spanZ } = extents(prop);
    const within = (centre: Point) => interior
      ? { x: Math.max(-width / 2 + spanX / 2, Math.min(width / 2 - spanX / 2, centre.x)), z: Math.max(-depth / 2 + spanZ / 2, Math.min(depth / 2 - spanZ / 2, centre.z)) }
      : centre;
    const clear = (centre: Point) => flat(prop) || !props.some(other => !flat(other) && overlaps(rectOf({ ...prop, centre }, 0), rectOf(other, 0)));
    prop.centre = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 8, -8, 10, -10].map(step => within(add(point, tangent, step * 0.3))).find(clear) ?? within(point);
    props.push(prop);
  }
  return { interior, width, depth, height, props };
}
type SetLayout = ReturnType<typeof layOut>;

/** The direction of a prop's side, from its facing; left and right are as seen by someone looking at its front. */
function sideOf(prop: Footprint, side: "front" | "back" | "left" | "right" | "on") {
  if (side === "back") return { x: -prop.facing.x, z: -prop.facing.z };
  if (side === "left") return leftOf(prop.facing);
  if (side === "right") return { x: prop.facing.z, z: -prop.facing.x };
  return prop.facing;
}

/** The scene of a set with everyone waiting below the floor; each shot's tracks bring in the people who are in it. */
export function buildSet(spec: PrevisSpec): SceneDocument {
  const set = layOut(spec);
  const { width, depth, height } = set;
  const view = roomView(set);
  const plane = (id: string, size: { width: number; height: number }, position: { x: number; y: number; z: number }, rotation: { rotationX: number; rotationY: number }, color: string, name = id): SceneDocument["objectList"][number] => ({
    threeJsonId: id, name, objType: "plane", geometry: size, position, rotation: { ...rotation, rotationZ: 0 }, material: { type: "standard", color },
  });
  // Planes show only their front, so the walls, facing in, are seen from inside and seen through from outside, as on a
  // film set with a wall taken out: a camera that steps back for a wide shot is never blocked by the wall behind it.
  // The floor runs on under that camera; past the walls there is nothing, rendered as the far background.
  const room = set.interior ? [
    plane("floor", { width: width + 2 * floorRunOn, height: depth + 2 * floorRunOn }, { x: 0, y: 0.002, z: 0 }, { rotationX: -Math.PI / 2, rotationY: 0 }, colours.floor),
    plane("backWall", { width, height }, { x: 0, y: height / 2, z: -depth / 2 }, { rotationX: 0, rotationY: 0 }, colours.walls[0]!),
    plane("frontWall", { width, height }, { x: 0, y: height / 2, z: depth / 2 }, { rotationX: 0, rotationY: Math.PI }, colours.walls[0]!),
    plane("leftWall", { width: depth, height }, { x: -width / 2, y: height / 2, z: 0 }, { rotationX: 0, rotationY: Math.PI / 2 }, colours.walls[1]!),
    plane("rightWall", { width: depth, height }, { x: width / 2, y: height / 2, z: 0 }, { rotationX: 0, rotationY: -Math.PI / 2 }, colours.walls[2]!),
    plane("ceiling", { width, height: depth }, { x: 0, y: height, z: 0 }, { rotationX: Math.PI / 2, rotationY: 0 }, colours.ceiling),
  ] : [plane("ground", { width: 200, height: 200 }, { x: 0, y: 0.002, z: 0 }, { rotationX: -Math.PI / 2, rotationY: 0 }, colours.floor)];
  // Props are boxes, never cylinders, which the checks take for people; doors and windows are planes facing into the
  // room like the walls they are in, so a camera outside sees through them too.
  const props = set.props.map((prop, index): SceneDocument["objectList"][number] => {
    const position = { x: prop.centre.x, y: prop.bottom + prop.height / 2, z: prop.centre.z };
    const turn = Math.atan2(prop.facing.x, prop.facing.z);
    return opening(prop)
      ? plane(`prop${index + 1}`, { width: prop.width, height: prop.height }, position, { rotationX: 0, rotationY: turn }, colours.opening, prop.name)
      : {
          threeJsonId: `prop${index + 1}`, name: prop.name, objType: "box", geometry: { width: prop.width, height: prop.height, depth: prop.depth },
          position, rotation: { rotationX: 0, rotationY: turn, rotationZ: 0 }, material: { type: "standard", color: flat(prop) ? colours.flat : colours.prop, roughness: 0.9 },
        };
  });
  const people = spec.people.map((person, index): SceneDocument["objectList"][number] => ({
    threeJsonId: `person${index + 1}`, name: person.name, objType: "cylinder",
    geometry: { radiusTop: radius, radiusBottom: radius, height: standingHeight, radialSegments: 24 },
    position: { x: 0, y: hiddenDepth, z: 0 },
    material: { type: "standard", color: colours.people[index % colours.people.length]!, roughness: 0.8 },
  }));
  return {
    version: "next",
    sceneConfig: {
      scene: { background: "#202024" }, ...view,
      lights: [{ type: "ambient", color: "#ffffff", intensity: 0.9 }, { type: "directional", color: "#ffffff", intensity: 1.5, position: { x: 3, y: 6, z: 4 } }],
    },
    objectList: [...room, ...props, ...people],
  };
}

/** A camera at the front of the set looking at all of it, for shots with nobody in them. */
function roomView(set: Pick<SetLayout, "interior" | "depth">) {
  return set.interior
    ? { camera: { position: { x: 0, y: 1.5, z: set.depth / 2 - 0.2 }, fov: 55, near: 0.1, far: 1000 }, controls: { target: { x: 0, y: 1, z: -set.depth / 2 } } }
    : { camera: { position: { x: 0, y: 1.6, z: 8 }, fov: 50, near: 0.1, far: 1000 }, controls: { target: { x: 0, y: 1, z: 0 } } };
}

/** The camera of a shot with nobody in it: the whole set from the front. */
export function emptyShotView(spec: PrevisSpec) {
  return roomView({ interior: spec.set.interior, depth: spec.set.depth });
}

/** The height a camera must stay under: the ceiling of a room, none outdoors. */
export const ceilingOf = (spec: PrevisSpec) => spec.set.interior ? spec.set.height ?? wallHeight : Infinity;

/** What the renders show besides the set: no grid, and the sky only outdoors, so a room is seen against nothing. */
export const renderSettings = (spec: PrevisSpec) => ({ gridVisible: false, skyVisible: !spec.set.interior });

/** The height of a person's hip joint in a sitting or kneeling posture: on a chair, or kneeling on the floor or a seat. */
function hipOf(body: Place) {
  const seat = body.seat?.height ?? 0;
  if (body.posture === "seated" && seat < chairSeat) throw new Error("Seated posture requires a raised seat; floor sitting must use kneeling");
  return body.posture === "seated" ? seat + chairHip : seat + kneelHip;
}

/** A person's column for a body: as tall as the figure in that posture and turned their way, or laid along their bed. */
function transformOf(body: StagedBody) {
  const scale = { x: 1, y: 1, z: depthRatio };
  if (body.posture === "lying") {
    return { position: { x: body.x, y: (body.seat?.height ?? 0) + lyingMiddle, z: body.z }, rotation: body.seat?.alongX === false ? { x: Math.PI / 2, y: 0, z: 0 } : { x: 0, y: 0, z: Math.PI / 2 }, scale };
  }
  const top = body.posture === "standing" ? standingHeight : hipOf(body) + upperBody;
  return { position: { x: body.x, y: top / 2, z: body.z }, rotation: { x: 0, y: body.yaw, z: 0 }, scale: { ...scale, y: top / standingHeight } };
}

// Joint rotations of the figure on a chair and kneeling (seiza): thighs forward, shins down or folded back under them,
// hands resting on the thighs. Zero is the figure's relaxed standing pose.
const both = (side: "Hip" | "Knee" | "Ankle" | "Shoulder" | "Elbow", x: number) => ({ [`left${side}`]: { x, y: 0, z: 0 }, [`right${side}`]: { x, y: 0, z: 0 } });
const chairPose = { ...both("Hip", -1.5), ...both("Knee", 1.5), ...both("Shoulder", -0.4), ...both("Elbow", -0.8) };
const kneelPose = { ...both("Hip", -1.4), ...both("Knee", 2.85), ...both("Ankle", 0.9), ...both("Shoulder", -0.35), ...both("Elbow", -0.9) };

/** The jointed figure of a body: posed for its posture, its hips on the seat, and turned or laid the way the column is. */
function figureOf(body: StagedBody) {
  const seat = body.seat?.height ?? 0;
  if (body.posture === "lying") {
    // On the back with the head along the bed, toward the wall it stands against or to the left.
    const head = body.seat?.alongX === false ? new Vector3(0, 0, -1) : new Vector3(-1, 0, 0);
    const up = new Vector3(0, 1, 0);
    const rotation = new Euler().setFromRotationMatrix(new Matrix4().makeBasis(head.clone().cross(up), head, up));
    const feet = new Vector3(body.x, seat + lyingMiddle, body.z).addScaledVector(head, -figureHeight * figureScale / 2);
    return { position: { x: feet.x, y: feet.y, z: feet.z }, rotation: { rotationX: rotation.x, rotationY: rotation.y, rotationZ: rotation.z }, pose: {} };
  }
  const y = body.posture === "standing" ? 0 : hipOf(body) - figureHip * figureScale;
  const pose = body.posture === "standing" ? {} : body.posture === "seated" ? chairPose : kneelPose;
  return { position: { x: body.x, y, z: body.z }, rotation: { rotationX: 0, rotationY: body.yaw, rotationZ: 0 }, pose };
}

/**
 * The scene of a shot's opening frame with every person on set as a jointed figure in their posture and facing, for
 * the still images: a depth map of human shapes is what depth-controlled image models know, while the previs video
 * keeps the columns so a video model takes only the blocking from it.
 */
export function figureScene(scene: SceneDocument, shot: StagedShot): SceneDocument {
  return {
    ...scene,
    objectList: scene.objectList.map(object => {
      const body = object.objType === "cylinder" ? shot.opening.get(object.name ?? "") : undefined;
      if (!body) return object;
      const { position, rotation, pose } = figureOf(body);
      return {
        threeJsonId: object.threeJsonId, name: object.name, objType: "mannequin" as const, geometry: {}, position, rotation, pose,
        scale: { scaleX: figureScale, scaleY: figureScale, scaleZ: figureScale }, material: object.material,
      };
    }),
  };
}

/**
 * Stages every shot: who enters, each person's walk, change of posture and turn toward what they look at (the person
 * or prop the plan names, kept until it names another, or the nearest other person; someone alone keeps their way),
 * and the side of the camera. In a two-person
 * scene the camera keeps to one side of the line between them (the 180-degree rule), the side of its first view off
 * the line: a side across the line is mirrored back, a single of one person is shot from near the other's eyeline so
 * their face is seen, and an over-the-shoulder view looks past the near shoulder on that side.
 * ACT: A walk detours round the first prop in its way only, and the line is kept only while exactly two people are on
 * set; a crowded room or a group scene would need a path search and a line per pair of people facing each other.
 */
export function stageShots(spec: PrevisSpec, shots: SpecShot[]): StagedShot[] {
  const set = layOut(spec);
  const bodies = new Map<string, StagedBody>();
  let lineSide: number | undefined;
  const staged: StagedShot[] = [];
  /** The way a body turns to look at what it faces among `others`, or the nearest of them; alone, it keeps its way. */
  const turn = (body: StagedBody, name: string, others: Map<string, StagedBody>) => {
    const target = body.faces ? others.get(body.faces) ?? set.props.find(prop => prop.name === body.faces)?.centre
      : [...others].filter(([other]) => other !== name).map(([, other]) => other).sort((a, b) => distance(body, a) - distance(body, b))[0];
    return { ...body, yaw: target && distance(body, target) > 0.05 ? Math.atan2(target.x - body.x, target.z - body.z) : body.yaw };
  };
  for (const { shot, seconds, cast } of shots) {
    const plan = spec.shots.find(item => item.shot === shot);
    const starts = new Map(bodies);
    const entering = spec.people.filter(item => item.enters === shot || (item.enters < shot && !bodies.has(item.name)));
    for (const person of entering) starts.set(person.name, { ...place(set, person.at, person.posture, [...starts.values()]), yaw: 0, faces: person.faces });
    for (const person of entering) starts.set(person.name, turn(starts.get(person.name)!, person.name, starts));
    // Everyone who does not move keeps their place; the movers then take free spots one by one. Someone may move several
    // times, as in a long take: each move is a leg from where the one before ended, starting at its "at", or spread
    // evenly over the shot without one. Everyone ends each leg turned to what they look at.
    const ends = new Map(starts);
    const moves = (plan?.moves ?? []).filter(move => starts.has(move.name));
    const movers = [...new Set(moves.map(move => move.name))];
    for (const name of movers) ends.delete(name);
    const legs = new Map<string, { from: number; body: StagedBody }[]>();
    for (const name of movers) {
      const own = moves.filter(move => move.name === name);
      // Starts the spec check would refuse, which a plan that was not checked may still hold, are spread evenly instead.
      const evenly = own.some((move, index) => (move.at !== undefined && move.at > seconds - minMoveSeconds)
        || (own.length > 1 && (move.at === undefined || (index > 0 && move.at < own[index - 1]!.at! + minMoveSeconds))));
      let current = starts.get(name)!;
      legs.set(name, own.map((move, index) => {
        const posture = move.posture ?? current.posture;
        // Someone who gets up from a seat steps out in front of it; someone who stays on it takes the new posture there.
        const target = move.to ?? (current.seat ? { prop: current.seat.prop, side: posture === "standing" ? "front" as const : "on" as const } : undefined);
        const end = target ? place(set, target, posture, [...ends.values()]) : { ...current, posture };
        current = { ...end, yaw: current.yaw, faces: move.faces ?? current.faces };
        return { from: evenly || move.at === undefined ? seconds * index / own.length : move.at, body: current };
      }));
      ends.set(name, current);
    }
    for (const [name, body] of ends) ends.set(name, turn(body, name, ends));
    for (const [name, steps] of legs) legs.set(name, steps.map((step, index) => ({ ...step, body: index === steps.length - 1 ? ends.get(name)! : turn(step.body, name, ends) })));
    const tracks = spec.people.map((person, index) => {
      const objectId = `person${index + 1}`;
      const start = starts.get(person.name);
      if (!start || !cast.includes(person.name)) {
        const hidden = { position: { x: 0, y: hiddenDepth, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
        return { objectId, frames: [{ time: 0, ...hidden }, { time: seconds, ...hidden }] };
      }
      const steps = legs.get(person.name) ?? [{ from: 0, body: ends.get(person.name)! }];
      // Each leg walks from the end of the one before over its own seconds; before the first, they hold where they start.
      const frames = steps.flatMap((step, index) => {
        const until = steps[index + 1]?.from ?? seconds;
        const leg = walkFrames(set, index ? steps[index - 1]!.body : start, step.body, until - step.from).map(frame => ({ ...frame, time: frame.time + step.from }));
        return index ? leg.slice(1) : step.from > 0 ? [{ ...leg[0]!, time: 0 }, ...leg] : leg;
      });
      return { objectId, frames };
    });
    for (const [name, body] of ends) bodies.set(name, body);

    const present = [...starts.keys()];
    const subjects = cast.filter(name => starts.has(name));
    const camera = plan?.camera ?? { side: "front" as const };
    const over = camera.side === "overShoulder" && camera.over && cast.includes(camera.over) && starts.has(camera.over) ? camera.over : undefined;
    let direction = sideDirections[camera.side] ?? sideDirections.front!;
    if (present.length === 2) {
      const [a, b] = [...present].sort().map(name => starts.get(name)!) as [StagedBody, StagedBody];
      const length = distance(a, b);
      if (length > 0.1) {
        const line = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
        const crossOf = (vector: Point) => line.x * vector.z - line.z * vector.x;
        if (lineSide === undefined && !over && Math.abs(crossOf(direction)) > 0.2) lineSide = Math.sign(crossOf(direction));
        lineSide ??= 1;
        const across = { x: -line.z * lineSide, z: line.x * lineSide };
        if (over) direction = across;
        else if (subjects.length === 1) {
          const subject = starts.get(subjects[0]!)!;
          const other = starts.get(present.find(name => name !== subjects[0])!)!;
          const gaze = { x: (other.x - subject.x) / length, z: (other.z - subject.z) / length };
          direction = { x: gaze.x * Math.cos(eyelineAngle) + across.x * Math.sin(eyelineAngle), z: gaze.z * Math.cos(eyelineAngle) + across.z * Math.sin(eyelineAngle) };
        } else if (Math.abs(crossOf(direction)) > 0.2 && Math.sign(crossOf(direction)) !== lineSide) {
          const along = direction.x * line.x + direction.z * line.z;
          direction = { x: 2 * along * line.x - direction.x, z: 2 * along * line.z - direction.z };
        }
      }
    }
    // Where a leg ends, from where it was staged: on a seat, beside a prop, or on part of the floor in plain words.
    const where = (at: SpecPlace, body: StagedBody) => body.seat ? `on the ${body.seat.prop}`
      : typeof at === "string" ? `the ${at.replace(/[A-Z]/g, letter => ` ${letter.toLowerCase()}`)} of the place` : `the ${at.side && at.side !== "on" ? at.side : "front"} of the ${at.prop}`;
    const timeline = movers.filter(name => cast.includes(name)).flatMap(name => moves.filter(move => move.name === name).map((move, index) => {
      const { from, body } = legs.get(name)![index]!;
      const verb = { seated: "sits", kneeling: "kneels", lying: "lies", standing: "stands" }[body.posture];
      const goes = move.to && (body.seat ? `${verb} ${where(move.to, body)}` : `goes to ${where(move.to, body)}`);
      return { from, text: `from ${from.toFixed(1)} s ${name} ${[goes, move.posture, move.faces && `facing ${move.faces}`].filter(Boolean).join(", ") || "stays"}` };
    })).sort((a, b) => a.from - b.from).map(item => item.text).join("; ");
    staged.push({
      shot, seconds, tracks, subjects, opening: new Map([...starts].filter(([name]) => cast.includes(name))),
      timeline: timeline || `0.0–${seconds.toFixed(1)} s: keep the opening body positions and postures; no body-root motion is scheduled. This coarse proxy does not animate speech or lips.`,
      camera: { direction, angle: camera.angle ?? "eye", move: camera.move ?? "static", over },
    });
  }
  return staged;
}

/**
 * Where a place puts a person in a posture: on a seat, beside a prop, or on part of the floor, moved aside from the
 * people already there and out of any prop it falls in. Someone standing on a seat stands in front of it instead.
 */
function place(set: SetLayout, at: SpecPlace, posture: Posture, others: Point[]): Place {
  let point: Point;
  let tangent: Point = { x: 1, z: 0 };
  let seat: Place["seat"];
  if (typeof at === "string") point = roomPoint(set.width, set.depth, at);
  else {
    const prop = set.props.find(item => item.name === at.prop)!;
    const side = at.side ?? (prop.seat !== undefined ? "on" : "front");
    if (side === "on" && prop.seat !== undefined && posture !== "standing") {
      point = prop.centre;
      tangent = Math.abs(prop.facing.x) > 0.5 ? { x: 0, z: 1 } : { x: 1, z: 0 };
      seat = { prop: prop.name, height: prop.seat, alongX: extents(prop).x >= extents(prop).z };
    } else {
      const direction = sideOf(prop, side === "on" ? "front" : side);
      point = add(prop.centre, direction, halfAlong(prop, direction) + radius + clearance + 0.05);
      tangent = leftOf(direction);
    }
  }
  if (!seat) {
    const blocking = set.props.find(prop => obstacle(prop) && inside(point, rectOf(prop, radius + clearance)));
    if (blocking) {
      const direction = sideOf(blocking, "front");
      point = add(blocking.centre, direction, halfAlong(blocking, direction) + radius + clearance + 0.05);
      tangent = leftOf(direction);
    }
  }
  // People sharing a spot, such as two on one sofa or both at a table's front, stand side by side.
  const spot = [0, 1, -1, 2, -2, 3, -3].map(step => add(point, tangent, step * personGap)).find(spot => others.every(other => distance(other, spot) >= personGap)) ?? point;
  return { ...spot, posture, seat };
}

/**
 * The keyframes of one person over a shot: standing up when they have to walk, the walk (round the first prop in the
 * way) facing where they go, then settling into the end posture and turning to what they look at, sped up to fit the
 * shot when they would run over.
 */
function walkFrames(set: SetLayout, start: StagedBody, end: StagedBody, seconds: number) {
  const path = [start as Point];
  const moving = distance(start, end) > 0.05;
  if (moving) {
    // The props they leave and the seat they go to are not in their way.
    const blocking = set.props.filter(prop => obstacle(prop) && prop.name !== start.seat?.prop && prop.name !== end.seat?.prop)
      .map(prop => rectOf(prop, radius + 0.05)).find(rect => crosses(start, end, rect));
    if (blocking) {
      const corners = [{ x: blocking.minX, z: blocking.minZ }, { x: blocking.minX, z: blocking.maxZ }, { x: blocking.maxX, z: blocking.minZ }, { x: blocking.maxX, z: blocking.maxZ }]
        .map(corner => ({ x: corner.x + Math.sign(corner.x - (blocking.minX + blocking.maxX) / 2) * 0.05, z: corner.z + Math.sign(corner.z - (blocking.minZ + blocking.maxZ) / 2) * 0.05 }))
        .filter(corner => !crosses(start, corner, blocking) && !crosses(corner, end, blocking))
        .sort((a, b) => distance(start, a) + distance(a, end) - distance(start, b) - distance(b, end));
      if (corners[0]) path.push(corners[0]);
    }
    path.push(end);
  }
  const standing = (point: Point, yaw: number): StagedBody => ({ x: point.x, z: point.z, posture: "standing", yaw });
  const rise = moving && start.posture !== "standing" ? postureTime : 0;
  const walk = path.slice(1).reduce((sum, point, index) => sum + distance(path[index]!, point), 0) / walkSpeed;
  const settle = end.posture !== (moving ? "standing" : start.posture) ? postureTime : 0;
  const scale = Math.min(1, seconds * actionShare / Math.max(1e-6, rise + walk + settle));
  const keys: { time: number; body: StagedBody }[] = [{ time: 0, body: start }];
  let time = 0;
  if (rise) keys.push({ time: time += rise * scale, body: standing(start, start.yaw) });
  for (const [index, point] of path.slice(1).entries()) {
    const from = path[index]!;
    keys.push({ time: time += distance(from, point) / walkSpeed * scale, body: standing(point, Math.atan2(point.x - from.x, point.z - from.z)) });
  }
  if (settle) keys.push({ time: time += settle * scale, body: end });
  keys.push({ time: seconds, body: end });
  // Keyframe times must rise strictly; the action ends by actionShare of the shot, so the hold at its end always stays.
  // The last key, where they end, is always kept, so even a leg cut very short ends on its target.
  const frames = keys.filter((key, index) => index === 0 || (index === keys.length - 1 ? key.time > 0 : key.time > keys[index - 1]!.time + 1e-3));
  return frames.map(({ time, body }) => ({ time, ...transformOf(body) }));
}
