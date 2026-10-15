import { z } from "@toonflow/nodes-scaffold/runtime";

/**
 * The previs plan a text model writes for a whole film: the set, where each person is and how they move, and where the
 * camera stands, all by name and never by coordinates; code builds the 3D set and computes every camera from it.
 */

// Parts of the floor as seen from the front, where the camera of a wide shot stands looking at the back wall.
export const roomPlaces = ["centre", "back", "front", "left", "right", "backLeft", "backRight", "frontLeft", "frontRight"] as const;
export type RoomPlace = (typeof roomPlaces)[number];

/**
 * Real-world sizes in metres (width along the wall or across the room, depth, height). `wall` props stand against the
 * nearest wall facing into the room, `raised` ones hang that high, `seat` props are sat or lain on at that height.
 */
export const propKinds = {
  lowTable: { size: [1.2, 0.8, 0.35] },
  table: { size: [1.4, 0.8, 0.75] },
  desk: { size: [1.2, 0.6, 0.75], wall: true },
  chair: { size: [0.45, 0.45, 0.9], seat: 0.45 },
  sofa: { size: [2, 0.9, 0.85], seat: 0.45, wall: true },
  bed: { size: [1.6, 2, 0.5], seat: 0.5, wall: true },
  cushion: { size: [0.6, 0.6, 0.08], seat: 0.08 },
  bench: { size: [1.5, 0.45, 0.45], seat: 0.45 },
  cabinet: { size: [1, 0.45, 1.8], wall: true },
  counter: { size: [2, 0.6, 0.9], wall: true },
  door: { size: [0.9, 0.05, 2], wall: true },
  slidingDoor: { size: [1.8, 0.05, 1.8], wall: true },
  window: { size: [1.2, 0.05, 1], wall: true, raised: 0.9 },
  lamp: { size: [0.3, 0.3, 0.9] },
  car: { size: [1.8, 4.5, 1.5] },
  tree: { size: [0.8, 0.8, 5] },
  other: { size: [1, 1, 1] },
} satisfies Record<string, { size: [number, number, number]; wall?: boolean; raised?: number; seat?: number }>;
export type PropKind = keyof typeof propKinds;

export const postures = ["standing", "seated", "kneeling", "lying"] as const;
export type Posture = (typeof postures)[number];
export const cameraSides = ["front", "frontLeft", "frontRight", "left", "right", "back", "overShoulder"] as const;

const name = z.string().trim().min(1).max(60);
const place = z.union([z.enum(roomPlaces), z.strictObject({ prop: name, side: z.enum(["front", "back", "left", "right", "on"]).optional() })]);
export type Place = z.infer<typeof place>;
const metres = z.number().min(0.05).max(50);

export const previsSpecSchema = z.strictObject({
  set: z.strictObject({
    interior: z.boolean(),
    width: z.number().min(2).max(40),
    depth: z.number().min(2).max(40),
    height: z.number().min(2).max(10).optional(),
    props: z.array(z.strictObject({
      name, kind: z.enum(Object.keys(propKinds) as [PropKind, ...PropKind[]]), at: place,
      size: z.strictObject({ width: metres, depth: metres, height: metres }).optional(),
    })).max(40),
  }),
  people: z.array(z.strictObject({ name, enters: z.number().int().min(1), at: place, posture: z.enum(postures), faces: name.optional() })).min(1).max(12),
  shots: z.array(z.strictObject({
    shot: z.number().int().min(1),
    moves: z.array(z.strictObject({ name, to: place.optional(), posture: z.enum(postures).optional(), faces: name.optional() })).max(12).optional(),
    camera: z.strictObject({
      side: z.enum(cameraSides), over: name.optional(),
      angle: z.enum(["eye", "low", "high"]).optional(), move: z.enum(["static", "pushIn", "pullOut", "follow"]).optional(),
    }),
  })).max(200),
});
export type PrevisSpec = z.infer<typeof previsSpecSchema>;
export type SpecShot = { shot: number; seconds: number; cast: string[] };

/** The instruction for the plan, with the script as {{ref 1}} and the shot list as {{ref 2}}. */
export function previsSpecPrompt(shots: SpecShot[]) {
  return [
    "{{ref 1}} is the script of a short film and {{ref 2}} its shot list. Read both completely, then plan the previs of every shot: the set, where each person is and moves, and where the camera stands. Code builds the 3D set and computes every camera from your plan, so you name places and never give coordinates.",
    `The shots: ${shots.map(item => `${item.shot} (${item.seconds} s${item.cast.length ? `, in frame: ${item.cast.join(", ")}` : ""})`).join("; ")}.`,
    "",
    "Reply with one JSON object only, no other text: {\"set\": {...}, \"people\": [...], \"shots\": [...]}.",
    "",
    "set: the one place where the shots happen.",
    "- \"interior\": true for a room, false for outdoors; \"width\" and \"depth\": the floor in metres at real scale (a six-mat Japanese room is about 3.6 by 2.7, a living room about 5 by 4).",
    "- \"props\": every piece of furniture, door and window the shots use or the script names, each {\"name\": a unique name, \"kind\": a kind below, \"at\": a place}. Leave out things held in the hand, and floor coverings such as tatami or rugs: the floor is built already.",
    `- Kinds: ${Object.keys(propKinds).filter(kind => kind !== "other").join(", ")}, or "other" with "size": {"width", "depth", "height"} in metres. Doors, sliding doors, windows, desks, sofas, beds, cabinets and counters stand against the wall nearest their place.`,
    "",
    "A place is a part of the floor seen from the front, where the camera of a wide shot stands looking at the back wall: \"centre\", \"back\", \"front\", \"left\", \"right\", \"backLeft\", \"backRight\", \"frontLeft\" or \"frontRight\". Or beside a prop: {\"prop\": its name, \"side\": \"front\", \"back\", \"left\" or \"right\"}, where a door's or window's front is the room side; or on a chair, sofa, bed, cushion or bench: {\"prop\": its name, \"side\": \"on\"}.",
    "",
    "people: everyone in any shot, named exactly as the shot list names them: {\"name\", \"enters\": the first shot they are in the place, \"at\": where they are when that shot starts, \"posture\": \"standing\", \"seated\", \"kneeling\" or \"lying\", \"faces\": the person or prop they look at}. Someone who comes in through a door enters at its front, as it opens. Once in, people stay in the place.",
    "",
    "shots: one per shot, in order: {\"shot\": its number, \"moves\": [...], \"camera\": {...}}.",
    "- \"moves\": each person who moves, changes posture or turns to look at something else during the shot: {\"name\", \"to\": the place where they end, \"posture\": their posture at the end, \"faces\": the person or prop they look at by the end}; leave out what does not change. Everyone starts where the previous shot left them and keeps looking at what they looked at, so leave out anyone who stays as they are.",
    "- \"faces\" names a person or a prop exactly as the plan does; leave it out to have someone look at the nearest other person.",
    "- \"camera\": {\"side\": where the camera stands, seen from the front: \"front\", \"frontLeft\", \"frontRight\", \"left\", \"right\" or \"back\"; or \"overShoulder\" with \"over\": the person whose shoulder it looks past at another person; \"angle\": \"eye\", \"low\" or \"high\"; \"move\": \"static\", \"pushIn\", \"pullOut\" or \"follow\"}. The shot size and who is in frame come from the shot list.",
    "",
    "Follow each row's action, camera and state cells and the script. Keep the staging continuous: when a row's state disagrees with what the previous shots showed, keep the earlier staging unless the row's action changes it.",
  ].join("\n");
}

const isSeat = (kind: PropKind) => "seat" in propKinds[kind];
const onWall = (kind: PropKind) => "wall" in propKinds[kind];

/**
 * Reads the model's reply into a plan and lists what is wrong with it for the model to fix: the JSON and its shape,
 * then names that point nowhere, people missing from the shots they are in frame in, seats that are not seats, and
 * looks at nothing in the plan.
 * Behind a prop against a room's wall is inside the wall, and the model writes it for someone at a door, so it is
 * read as the prop's room side rather than sent back.
 * A shot the plan leaves out keeps everyone still under a front camera.
 */
export function readPrevisSpec(reply: string, shots: SpecShot[]): { spec?: PrevisSpec; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? "");
  } catch {
    return { problems: ["The reply is not one JSON object."] };
  }
  const parsed = previsSpecSchema.safeParse(value);
  if (!parsed.success) return { problems: [z.prettifyError(parsed.error)] };
  const spec = parsed.data;
  const problems: string[] = [];
  const props = new Map<string, PropKind>();
  const checkPlace = (place: Place, where: string, seat = false) => {
    if (typeof place === "string") return;
    const kind = props.get(place.prop);
    if (!kind) problems.push(`${where} names the prop "${place.prop}", which the set does not have (or has only later in its list).`);
    else if (place.side === "on" && !isSeat(kind)) problems.push(`${where} puts someone on "${place.prop}", a ${kind}; only a chair, sofa, bed, cushion or bench can be sat on.`);
    else if (place.side === "back" && onWall(kind) && spec.set.interior) place.side = "front";
    else if (seat && place.side === "on") problems.push(`${where} puts a prop on "${place.prop}"; put it beside it instead.`);
  };
  for (const prop of spec.set.props) {
    if (props.has(prop.name)) problems.push(`Two props are named "${prop.name}"; give each a unique name.`);
    checkPlace(prop.at, `The prop "${prop.name}"`, true);
    if (prop.kind === "other" && !prop.size) problems.push(`The prop "${prop.name}" is of kind "other" and needs a "size".`);
    props.set(prop.name, prop.kind);
  }
  const people = new Map(spec.people.map(person => [person.name, person]));
  const checkFaces = (faces: string | undefined, who: string) => {
    if (faces && !people.has(faces) && !props.has(faces)) problems.push(`${who} looks at "${faces}", which is neither a person nor a prop of the plan.`);
  };
  for (const person of spec.people) {
    checkPlace(person.at, `${person.name}'s entrance`);
    checkFaces(person.faces, person.name);
  }
  for (const { shot, cast } of shots) {
    for (const name of cast) {
      const person = people.get(name);
      if (!person) problems.push(`Shot ${shot} has ${name} in frame, but "people" does not list them; name them exactly as the shot list does.`);
      else if (person.enters > shot) problems.push(`Shot ${shot} has ${name} in frame, but they enter only in shot ${person.enters}.`);
    }
  }
  for (const item of spec.shots) {
    for (const move of item.moves ?? []) {
      const person = people.get(move.name);
      if (!person) problems.push(`Shot ${item.shot} moves ${move.name}, who is not in "people".`);
      else if (person.enters > item.shot) problems.push(`Shot ${item.shot} moves ${move.name}, who enters only in shot ${person.enters}.`);
      if (move.to) checkPlace(move.to, `Shot ${item.shot}'s move of ${move.name}`);
      checkFaces(move.faces, `In shot ${item.shot}, ${move.name}`);
    }
    const { over } = item.camera;
    if (item.camera.side === "overShoulder" && (!over || !people.has(over))) problems.push(`Shot ${item.shot} looks over a shoulder, but "over" does not name a person in "people".`);
  }
  return problems.length ? { problems } : { spec, problems };
}
