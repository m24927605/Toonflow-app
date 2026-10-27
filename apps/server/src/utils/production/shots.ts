import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import type { Production, ProductionAsset } from "./state";
import type { VisualCheck } from "./checks";
import type { ProductionPlan } from "./plan";

/**
 * One shot of the film as the clips need it: its time, shot-list row and character state, the place its row names and
 * the outfit each person wears in it, by name. Everyone has an outfit, as the previs may show anyone.
 */
export type ProductionShot = {
  shot: number; time: string; state?: string; place?: string; row?: string; outfits: Record<string, string>;
  /**
   * The picture this clip starts from: the previous clip's last clear frame when it keeps that clip's camera setup,
   * otherwise the shot's keyframe, drawn from the people's and the place's designs.
   */
  startFrame?: string;
  /** The keyframe's still-frame description, which the clip prompt takes as its opening, and its image prompt. */
  keyframe?: { description: string; prompt: string; check?: VisualCheck };
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

/**
 * Whether everyone in a shot opens upright, by the contract's English pose text: the previs draws people as upright
 * columns, so a shot where anyone lies, sits or kneels must not take its shapes from the previs.
 * ACT: matched by words; a pose phrased otherwise counts as upright.
 */
export function opensUpright(production: Production, shot: number) {
  const actors = production.plan?.shots.find(item => item.shot === shot)?.actors ?? [];
  return !actors.some(actor => /\b(lie|lies|lying|lay|lays|laying|sit|sits|sitting|seated|kneel\w*|knelt|crouch\w*|squat\w*|reclin\w*|straddl\w*|missionary|on (?:all fours|(?:his|her|their) (?:back|side|stomach|knees)))\b/i.test(actor.pose));
}
