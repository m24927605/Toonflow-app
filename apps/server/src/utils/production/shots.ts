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
  /**
   * The previous clip's last clear frame, which this clip starts from when it keeps that clip's camera setup; every
   * other clip starts from no picture at all, its people kept by their LoRAs.
   */
  startFrame?: string;
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

// Sulphur 2 loads at most four LoRAs: those of the people in frame.
const maxPeople = 8;
export const maxLoras = 4;
const hasLtx = (item: ProductionAsset) => !!(item.triggers?.ltx || item.loras?.some(lora => lora.family === "ltx"));

/**
 * Who a shot shows, each person the previs shows with those in the opening first, and the place it is in: the people's
 * LoRAs and trigger words are what keep them the same from clip to clip. They follow the plan, not the drawing.
 */
export function shotReferences(shot: ProductionShot, assets: NonNullable<Production["assets"]>, framed: { opening: string[]; shown: string[] }) {
  const names = [...new Set([...framed.opening, ...framed.shown])];
  if (names.length > maxPeople || names.some(name => !byName(assets.characters, name))) throw new Error(`Shot ${shot.shot}: unknown cast or more people than a clip can name`);
  const persons = names.map(name => byName(assets.characters, name)!);
  const place = byName(assets.places, shot.place);
  if (!place) throw new Error(`Shot ${shot.shot}: unknown environment`);
  if (persons.filter(hasLtx).length > maxLoras) throw new Error(`Shot ${shot.shot}: more than four LoRAs (one a person) cannot be loaded; revise the shot before dispatch`);
  return { people: persons.map(person => ({ person })), place: { place } };
}
