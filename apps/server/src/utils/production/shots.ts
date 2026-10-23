import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import type { Production, ProductionAsset } from "./state";
import type { ProductionPlan } from "./plan";

/**
 * One shot of the film as the clips need it: its time, shot-list row and character state, the place its row names and
 * the outfit each person wears in it, by name. Everyone has an outfit, as the previs may show anyone.
 */
export type ProductionShot = {
  shot: number; time: string; state?: string; place?: string; row?: string; outfits: Record<string, string>;
  /** Each person of the opening drawn in their outfit and their pose in the previs, by name, once drawn. */
  poses?: Record<string, string>;
  /** The photographic opening frame the clip starts from, once drawn. */
  keyframe?: string;
};

const seconds = (value: number) => Number(value.toFixed(2));

/**
 * One plan per shot of the shot list, with the place its row names (or the only one) and everyone's outfit; who is in it
 * comes from the shot's previs.
 */
export function planShots(shotList: string, assets: NonNullable<Production["assets"]>, plan: ProductionPlan) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  return spans.map((span): ProductionShot => {
    const contract = plan.shots.find(item => item.shot === span.shot);
    if (!contract || !assets.places.some(place => place.name === contract.place)) throw new Error(`Shot ${span.shot}: missing environment contract`);
    return {
      shot: span.shot, time: `${seconds(span.start)}–${seconds(span.end)}s`, state: span.state, row: span.row,
      outfits: Object.fromEntries(contract.actors.map(actor => [actor.name, actor.outfit])), place: contract.place,
    };
  });
}

const byName = (list: ProductionAsset[], name?: string) => list.find(item => item.name === name);

// The keyframe's depth model takes nine images beside its depth map: one pose/outfit per person and the environment.
const maxPeople = 8;
export const maxLoras = 4;

/**
 * The references a shot's keyframe is drawn from, in order: each person the previs shows, those in the opening first,
 * in the outfit they wear in the shot, then the place. They follow the plan, not the drawing; an image is the design's
 * view once it is drawn.
 */
export function shotReferences(shot: ProductionShot, assets: NonNullable<Production["assets"]>, framed: { opening: string[]; shown: string[] }) {
  const names = [...new Set([...framed.opening, ...framed.shown])];
  if (names.length > maxPeople || names.some(name => !byName(assets.characters, name))) throw new Error(`Shot ${shot.shot}: unknown cast or more people than a keyframe can be drawn from`);
  const persons = names.map(name => byName(assets.characters, name)!);
  if (persons.filter(person => person.triggers?.ltx || person.loras?.some(lora => lora.family === "ltx")).length > maxLoras) throw new Error(`Shot ${shot.shot}: more than four character LoRAs cannot be loaded; revise the shot before dispatch`);
  const place = byName(assets.places, shot.place);
  if (!place) throw new Error(`Shot ${shot.shot}: unknown environment`);
  // A person drawn in their opening pose shows the clip that pose rather than standing facing the camera; one without a
  // pose, such as someone who comes in later, is shown in three-quarter view, as a view facing the camera makes the clip
  // look into the lens.
  const image = (person: ProductionAsset) => shot.poses?.[person.name] ?? outfitView(person, shot, 1);
  return { people: persons.map(person => ({ person, image: image(person) })), place: place ? { place, image: place.views?.[0] ?? place.base } : undefined };
}

/**
 * A person's view in the outfit they wear in a shot, the front view unless `view` picks another of the outfit's views,
 * or their base image before the views are drawn.
 */
export const outfitView = (person: ProductionAsset, shot: ProductionShot, view = 0) => {
  const outfit = person.outfits?.find(outfit => outfit.name === shot.outfits[person.name]);
  if (!outfit) throw new Error(`Shot ${shot.shot}: unknown outfit for ${person.name}`);
  return outfit.views?.[Math.min(view, outfit.views.length - 1)];
};

/** The reference images in prompt order, once every one is drawn. */
export function referenceImages(references: ReturnType<typeof shotReferences>) {
  const images = [...references.people.map(entry => entry.image), ...references.place ? [references.place.image] : []];
  if (images.some(image => !image)) throw new Error("A keyframe's reference images are not drawn yet");
  return images as string[];
}
