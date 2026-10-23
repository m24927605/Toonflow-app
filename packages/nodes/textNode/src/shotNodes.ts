import type { Edge, GraphNode } from "@vue-flow/core";
import { translate } from "@toonflow/i18n/vue";
import { keyframeTemplate } from "@toonflow/node-shared/keyframePrompt";
import { roleOf, shotNumberOf } from "@toonflow/node-shared/nodeRole";
import { suggestMasterShot, type MasterShotSuggestion, type ShotSpan } from "@toonflow/node-shared/shotList";

export type ShotReference = { nodeId: string; label: string };
/** One outfit of one person: `name` labels it in templates, such as 日女（裸身）, and `person` is who it is. */
export type ShotCharacter = { name: string; person: string; outfit?: string; cells: ShotReference[] };
export type ShotNodesPlan = {
  /** Whether the shot list has a cast column, so each shot's cast can be preset from it. */
  castColumn: boolean;
  /** Shots without a keyframe node. */
  keyframesToBuild: ShotSpan[];
  /** Shots whose keyframe is generated but that have no video node yet; each shot moves on as soon as its own keyframe is ready. */
  videosToBuild: ShotSpan[];
  /** Shots whose keyframe node exists but has not generated an image yet. */
  waiting: number[];
  /** The keyframe node of each shot, which becomes the video's first frame. */
  keyframes: Map<number, string>;
  /** Shots whose keyframe is generated, the ones a video can start from. */
  generatedKeyframes: Set<number>;
  /** The video generation node of each shot. */
  videos: Map<number, string>;
  /** The previs layout image of each shot, which its keyframe follows for composition. */
  layouts: Map<number, string>;
  /** The previs video of each shot, which its video node takes as a blocking reference. */
  previsVideos: Map<number, string>;
  scenes: ShotReference[];
  characters: ShotCharacter[];
  /** Text nodes feeding the shot list, taken as its original script and given to every per-shot text node too. */
  scripts: ShotReference[];
  /** The master shot preselected in the dialog. */
  masterSuggestion?: MasterShotSuggestion;
};

/** `cast` lists, per shot, the indexes into `characters` of the people in that shot; `masterShot` is 0 for none. */
export type ShotNodesChoice = {
  scenes: string[]; characters: { name: string; person: string; cells: string[] }[]; cast: Record<number, number[]>; masterShot: number;
  template: string; videoTemplate: string; textNodes: boolean;
};

/**
 * Who is in each shot to build, as each person's outfit name ("" for someone absent): a person counts when their name
 * is in the shot's cast cell, or everyone without a cast column; the outfit is the one the shot's row mentions (its
 * state cell first), else the first one.
 */
export function defaultCast(plan: ShotNodesPlan) {
  return Object.fromEntries(plan.keyframesToBuild.map(span => [span.shot, Object.fromEntries(
    [...new Set(plan.characters.map(item => item.person))].map(person => {
      const outfits = plan.characters.filter(item => item.person === person);
      if (span.cast !== undefined && !span.cast.includes(person) && !outfits.some(item => span.cast!.includes(item.name))) return [person, ""];
      const text = `${span.state ?? ""} ${span.row ?? ""}`;
      return [person, (outfits.find(item => item.outfit && text.includes(item.outfit)) ?? outfits[0]!).name];
    }))]));
}

/** The keyframe template for these references: the scenes, then every view of each person, each named by the chosen view. */
export function shotNodesTemplate(sceneCount: number, characters: { name: string; cells: string[]; view: string }[]) {
  let next = sceneCount + 1;
  const named = characters.map(item => {
    const ref = next + item.cells.indexOf(item.view);
    next += item.cells.length;
    return { name: item.name, ref };
  });
  return keyframeTemplate(Array.from({ length: sceneCount }, (_, index) => index + 1), named).map(line => typeof line === "string" ? line : translate(line)).join("\n");
}

// Music is laid over the joined film afterwards, so every shot keeps only the sound of the scene and cuts stay seamless.
export const defaultVideoTemplate = () => [
  translate("Start from the first frame and keep the people, clothing and set unchanged."),
  "{{shot}}",
  translate("No background music: only dialogue and the sounds of the scene."),
].join("\n");

/** What the Build shot nodes dialog proposes: every scene and character, each person's first view, the suggested master shot. */
export function defaultShotNodesChoice(plan: ShotNodesPlan): ShotNodesChoice {
  const characters = plan.characters.map(item => ({ name: item.name, person: item.person, cells: item.cells.map(cell => cell.nodeId) }));
  const cast = defaultCast(plan);
  return {
    scenes: plan.scenes.map(item => item.nodeId), characters,
    cast: Object.fromEntries(plan.keyframesToBuild.map(span => [span.shot, characters.flatMap((item, index) => cast[span.shot]![item.person] === item.name ? [index] : [])])),
    masterShot: plan.keyframesToBuild.length ? plan.masterSuggestion?.shot ?? 0 : 0,
    template: shotNodesTemplate(plan.scenes.length, characters.map(item => ({ ...item, view: item.cells[0]! }))),
    videoTemplate: defaultVideoTemplate(), textNodes: true,
  };
}

const imageUrl = (node: GraphNode) => node.data?.outputs?.image?.value?.url as string | undefined;
const labelOf = (node: GraphNode) => String(node.data?.label ?? "");


/**
 * Works out which shot nodes to create and which canvas images to reference, by node role: keyframes, layouts and shot
 * videos by their shot number, and characters and scenes among the selected images, or else every image on the canvas.
 * Each shot gets a keyframe node first and a video node once its own keyframe is generated, so a few shots can be
 * finished before the rest. Views of one person share their name and are grouped by outfit.
 */
export function planShotNodes(shotListId: string, markdown: string, spans: ShotSpan[], nodes: GraphNode[], edges: Edge[], selectedIds: Set<string>): ShotNodesPlan {
  const byShot = (type: string, role?: string) => new Map(nodes.flatMap(node => {
    const shot = node.type === type && roleOf(node) === role ? shotNumberOf(node) : undefined;
    return shot === undefined ? [] : [[shot, node] as const];
  }));
  const keyframeNodes = byShot("remote-imageGenerationNode", "keyframe");
  const videoNodes = byShot("remote-videoGenerationNode");
  const generated = (span: ShotSpan) => !!imageUrl(keyframeNodes.get(span.shot)!);
  const keyframes = new Map([...keyframeNodes].map(([shot, node]) => [shot, node.id]));

  const images = nodes.filter(node => imageUrl(node));
  const selected = images.filter(node => selectedIds.has(node.id));
  const pool = selected.length ? selected : images;
  const characters = new Map<string, ShotCharacter>();
  const scenes: ShotReference[] = [];
  for (const node of pool) {
    const reference = { nodeId: node.id, label: labelOf(node) };
    if (roleOf(node) === "scene") scenes.push(reference);
    if (roleOf(node) !== "character") continue;
    // Views of one person in one outfit form one character; another outfit of the same person is a sibling entry.
    const person = String(node.data?.character ?? "").trim() || reference.label;
    const outfit = String(node.data?.outfit ?? "").trim() || undefined;
    const name = outfit ? `${person}\uff08${outfit}\uff09` : person;
    const entry = characters.get(name) ?? { name, person, ...outfit ? { outfit } : {}, cells: [] };
    entry.cells.push(reference);
    characters.set(name, entry);
  }
  const castCharacters = [...characters.values()].map(item => ({ ...item, cells: item.cells.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })) }));
  const layouts = new Map(images.flatMap(node => {
    const shot = roleOf(node) === "layout" ? shotNumberOf(node) : undefined;
    return shot === undefined ? [] : [[shot, node.id] as const];
  }));
  const previsVideos = new Map(nodes.flatMap(node => {
    const shot = roleOf(node) === "previs" && node.data?.outputs?.video?.value?.url ? shotNumberOf(node) : undefined;
    return shot === undefined ? [] : [[shot, node.id] as const];
  }));
  return {
    castColumn: spans.some(span => span.cast !== undefined),
    keyframesToBuild: spans.filter(span => !keyframeNodes.has(span.shot)),
    videosToBuild: spans.filter(span => keyframeNodes.has(span.shot) && generated(span) && !videoNodes.has(span.shot)),
    waiting: spans.filter(span => keyframeNodes.has(span.shot) && !generated(span)).map(span => span.shot),
    keyframes,
    generatedKeyframes: new Set(spans.filter(span => keyframeNodes.has(span.shot) && generated(span)).map(span => span.shot)),
    videos: new Map([...videoNodes].map(([shot, item]) => [shot, item.id])),
    layouts,
    previsVideos,
    scenes,
    scripts: edges.flatMap(edge => {
      const source = edge.target === shotListId && edge.targetHandle === "in" && edge.sourceHandle === "text" ? nodes.find(node => node.id === edge.source) : undefined;
      return source?.type === "remote-textNode" ? [{ nodeId: source.id, label: labelOf(source) }] : [];
    }),
    characters: castCharacters,
    masterSuggestion: suggestMasterShot(markdown, spans),
  };
}
