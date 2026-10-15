import type { SceneDocument } from "./scene";
import type { DirectorPlan } from "./sceneAnimation";
import { propKinds, type Place, type Posture, type PrevisSpec, type PropKind, type SpecShot } from "./previsSpec";

/**
 * Builds the set of a previs plan and stages its shots, by computation only: the room and props at real scale, every
 * person as a cylinder at the height of their posture, walks between named places, and which side of the people each
 * shot's camera stands on. Each shot starts from where the previous one left everyone, so nobody jumps between shots.
 */

type Point = { x: number; z: number };
type Footprint = { name: string; kind: PropKind; centre: Point; facing: Point; width: number; depth: number; height: number; bottom: number; seat?: number };
type Body = Point & { posture: Posture; seat?: { prop: string; height: number; alongX: boolean } };
export type StagedShot = {
  shot: number; seconds: number; tracks: DirectorPlan["tracks"]; subjects: string[];
  camera: { direction: Point; angle: "eye" | "low" | "high"; move: "static" | "pushIn" | "pullOut" | "follow"; over?: string };
};

// Cylinder people: a standing height, their radius, the top of a seated or kneeling body above what they sit on, and
// how far below the floor people wait before they enter.
const standingHeight = 1.7;
const radius = 0.22;
const seatedTop = 0.85;
const kneelingTop = 0.9;
const hiddenDepth = -10;
// Walking speed in metres a second, the time to sit down or stand up, and the share of a shot the action may take.
const walkSpeed = 1.1;
const postureTime = 1;
const actionShare = 0.9;
// The gap kept around props and between people, in metres.
const clearance = 0.15;
const personGap = 0.55;
const wallHeight = 2.4;
// How far the walls, floor and ceiling run on past the room, where only a camera outside it sees them.
const wallRunOn = 4;
// How far off the other person's eyeline the camera of a single stands, so the face is seen in three-quarter view.
const eyelineAngle = 35 * Math.PI / 180;

const sideDirections: Record<string, Point> = {
  front: { x: 0, z: 1 }, frontLeft: { x: -Math.SQRT1_2, z: Math.SQRT1_2 }, frontRight: { x: Math.SQRT1_2, z: Math.SQRT1_2 },
  left: { x: -1, z: 0 }, right: { x: 1, z: 0 }, back: { x: 0, z: -1 },
};
const colours = { floor: "#8c8273", walls: ["#b9b3a7", "#aaa498", "#c3bdb1"], ceiling: "#d2cec6", prop: "#6e5c49", opening: "#c9c1ad", people: ["#d9714e", "#4e8ad9", "#8bc34a", "#e0b84a", "#a46bd9", "#4ec2c2"] };

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
      const other = props.find(prop => prop.name === (item.at as Exclude<Place, string>).prop)!;
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
    const clear = (centre: Point) => !props.some(other => overlaps(rectOf({ ...prop, centre }, 0), rectOf(other, 0)));
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
  const plane = (id: string, size: { width: number; height: number }, position: { x: number; y: number; z: number }, rotation: { rotationX: number; rotationY: number }, color: string): SceneDocument["objectList"][number] => ({
    threeJsonId: id, name: id, objType: "plane", geometry: size, position, rotation: { ...rotation, rotationZ: 0 }, material: { type: "standard", color },
  });
  // Planes show only their front, so the walls, facing in, are seen from inside and seen through from outside, as on a
  // film set with a wall taken out: a camera that steps back for a wide shot is never blocked by the wall behind it.
  // They run on past the room, hidden from inside by the walls across them, so that camera sees walls and not the sky
  // past a corner.
  const [across, deep] = [width + 2 * wallRunOn, depth + 2 * wallRunOn];
  const room = set.interior ? [
    plane("floor", { width: across, height: deep }, { x: 0, y: 0.002, z: 0 }, { rotationX: -Math.PI / 2, rotationY: 0 }, colours.floor),
    plane("backWall", { width: across, height }, { x: 0, y: height / 2, z: -depth / 2 }, { rotationX: 0, rotationY: 0 }, colours.walls[0]!),
    plane("frontWall", { width: across, height }, { x: 0, y: height / 2, z: depth / 2 }, { rotationX: 0, rotationY: Math.PI }, colours.walls[0]!),
    plane("leftWall", { width: deep, height }, { x: -width / 2, y: height / 2, z: 0 }, { rotationX: 0, rotationY: Math.PI / 2 }, colours.walls[1]!),
    plane("rightWall", { width: deep, height }, { x: width / 2, y: height / 2, z: 0 }, { rotationX: 0, rotationY: -Math.PI / 2 }, colours.walls[2]!),
    plane("ceiling", { width: across, height: deep }, { x: 0, y: height, z: 0 }, { rotationX: Math.PI / 2, rotationY: 0 }, colours.ceiling),
  ] : [plane("ground", { width: Math.max(width, depth) * 4, height: Math.max(width, depth) * 4 }, { x: 0, y: 0.002, z: 0 }, { rotationX: -Math.PI / 2, rotationY: 0 }, colours.floor)];
  // Props are boxes, never cylinders, which the checks take for people.
  const props = set.props.map((prop, index): SceneDocument["objectList"][number] => ({
    threeJsonId: `prop${index + 1}`, name: prop.name, objType: "box",
    geometry: { width: prop.width, height: prop.height, depth: prop.depth },
    position: { x: prop.centre.x, y: prop.bottom + prop.height / 2, z: prop.centre.z },
    rotation: { rotationX: 0, rotationY: Math.atan2(prop.facing.x, prop.facing.z), rotationZ: 0 },
    material: { type: "standard", color: prop.depth < 0.1 ? colours.opening : colours.prop, roughness: 0.9 },
  }));
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

/** A person's cylinder for a body: its height from the posture, or laid along the longer side of what they lie on. */
function transformOf(body: Body) {
  const rotation = { x: 0, y: 0, z: 0 };
  if (body.posture === "lying") {
    return { position: { x: body.x, y: (body.seat?.height ?? 0) + radius, z: body.z }, rotation: body.seat?.alongX === false ? { ...rotation, x: Math.PI / 2 } : { ...rotation, z: Math.PI / 2 }, scale: { x: 1, y: 1, z: 1 } };
  }
  const top = body.posture === "standing" ? standingHeight : (body.seat?.height ?? 0) + (body.posture === "kneeling" ? kneelingTop : seatedTop);
  return { position: { x: body.x, y: top / 2, z: body.z }, rotation, scale: { x: 1, y: top / standingHeight, z: 1 } };
}

/**
 * Stages every shot: who enters, each person's walk and change of posture, and the side of the camera. In a two-person
 * scene the camera keeps to one side of the line between them (the 180-degree rule), the side of its first view off
 * the line: a side across the line is mirrored back, a single of one person is shot from near the other's eyeline so
 * their face is seen, and an over-the-shoulder view looks past the near shoulder on that side.
 * ACT: A walk detours round the first prop in its way only, and the line is kept only while exactly two people are on
 * set; a crowded room or a group scene would need a path search and a line per pair of people facing each other.
 */
export function stageShots(spec: PrevisSpec, shots: SpecShot[]): StagedShot[] {
  const set = layOut(spec);
  const bodies = new Map<string, Body>();
  let lineSide: number | undefined;
  const staged: StagedShot[] = [];
  for (const { shot, seconds, cast } of shots) {
    const plan = spec.shots.find(item => item.shot === shot);
    const starts = new Map(bodies);
    for (const person of spec.people.filter(item => item.enters === shot || (item.enters < shot && !bodies.has(item.name)))) {
      const body = place(set, person.at, person.posture, [...starts.values()]);
      starts.set(person.name, body);
    }
    // Everyone who does not move keeps their place; the movers then end at free spots one by one.
    const ends = new Map(starts);
    const moves = (plan?.moves ?? []).filter(move => starts.has(move.name));
    for (const move of moves) ends.delete(move.name);
    for (const move of moves) {
      const start = starts.get(move.name)!;
      const posture = move.posture ?? start.posture;
      // Someone who gets up from a seat steps out in front of it; someone who stays on it takes the new posture there.
      const target = move.to ?? (start.seat ? { prop: start.seat.prop, side: posture === "standing" ? "front" as const : "on" as const } : undefined);
      ends.set(move.name, target ? place(set, target, posture, [...ends.values()]) : { ...start, posture });
    }
    const tracks = spec.people.map((person, index) => {
      const objectId = `person${index + 1}`;
      const start = starts.get(person.name);
      if (!start) {
        const hidden = { position: { x: 0, y: hiddenDepth, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
        return { objectId, frames: [{ time: 0, ...hidden }, { time: seconds, ...hidden }] };
      }
      return { objectId, frames: walkFrames(set, start, ends.get(person.name)!, seconds) };
    });
    for (const [name, body] of ends) bodies.set(name, body);

    const present = [...starts.keys()];
    const subjects = cast.filter(name => starts.has(name));
    const camera = plan?.camera ?? { side: "front" as const };
    const over = camera.side === "overShoulder" && camera.over && starts.has(camera.over) ? camera.over : undefined;
    let direction = sideDirections[camera.side] ?? sideDirections.front!;
    if (present.length === 2) {
      const [a, b] = [...present].sort().map(name => starts.get(name)!) as [Body, Body];
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
    staged.push({
      shot, seconds, tracks, subjects: subjects.length ? subjects : present,
      camera: { direction, angle: camera.angle ?? "eye", move: camera.move ?? "static", over },
    });
  }
  return staged;
}

/**
 * Where a place puts a person in a posture: on a seat, beside a prop, or on part of the floor, moved aside from the
 * people already there and out of any prop it falls in. Someone standing on a seat stands in front of it instead.
 */
function place(set: SetLayout, at: Place, posture: Posture, others: Body[]): Body {
  let point: Point;
  let tangent: Point = { x: 1, z: 0 };
  let seat: Body["seat"];
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
    const blocking = set.props.find(prop => inside(point, rectOf(prop, radius + clearance)));
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
 * way), then settling into the end posture, sped up to fit the shot when they would run over.
 */
function walkFrames(set: SetLayout, start: Body, end: Body, seconds: number) {
  const path = [start as Point];
  const moving = distance(start, end) > 0.05;
  if (moving) {
    // The props they leave and the seat they go to are not in their way.
    const blocking = set.props.filter(prop => prop.name !== start.seat?.prop && prop.name !== end.seat?.prop)
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
  const standing = (point: Point): Body => ({ x: point.x, z: point.z, posture: "standing" });
  const rise = moving && start.posture !== "standing" ? postureTime : 0;
  const walk = path.slice(1).reduce((sum, point, index) => sum + distance(path[index]!, point), 0) / walkSpeed;
  const settle = end.posture !== (moving ? "standing" : start.posture) ? postureTime : 0;
  const scale = Math.min(1, seconds * actionShare / Math.max(1e-6, rise + walk + settle));
  const keys: { time: number; body: Body }[] = [{ time: 0, body: start }];
  let time = 0;
  if (rise) keys.push({ time: time += rise * scale, body: standing(start) });
  for (const [index, point] of path.slice(1).entries()) keys.push({ time: time += distance(path[index]!, point) / walkSpeed * scale, body: standing(point) });
  if (settle) keys.push({ time: time += settle * scale, body: end });
  keys.push({ time: seconds, body: end });
  // Keyframe times must rise strictly; the action ends by actionShare of the shot, so the hold at its end always stays.
  const frames = keys.filter((key, index) => index === 0 || key.time > keys[index - 1]!.time + 1e-3);
  return frames.map(({ time, body }) => ({ time, ...transformOf(body) }));
}
