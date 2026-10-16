import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans } from "@toonflow/node-shared/shotList";
import type { Production, ProductionAsset } from "./state";

/**
 * One shot of the film as the clips need it: its time, shot-list row and character state, the place its row names and
 * the outfit each person wears in it, by name. Everyone has an outfit, as the previs may show anyone.
 */
export type ProductionShot = { shot: number; time: string; state?: string; place?: string; row?: string; outfits: Record<string, string> };

const seconds = (value: number) => Number(value.toFixed(2));

/**
 * One plan per shot of the shot list, with the place its row names (or the only one) and everyone's outfit; who is in it
 * comes from the shot's previs.
 */
export function planShots(shotList: string, assets: NonNullable<Production["assets"]>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const people = new Set(assets.characters.map(item => item.name));
  // Each person wears the outfit the shot's state (or else its row) names, or else what they wore in their last shot,
  // or else their first outfit, so clothes only change where the shot list says so.
  const worn = new Map<string, string>();
  return spans.map((span): ProductionShot => {
    const cast = castNames(span).filter(name => people.has(name));
    const outfits = Object.fromEntries(assets.characters.map(({ name, outfits: options = [] }) => {
      // Within the person's part of the state ("Name: ...;"), the outfit named first is the one worn, as in "white shirt
      // (suit jacket off)".
      // A whole cell is one person's only when the cast cell names them alone.
      const size = cast.includes(name) ? cast.length : 0;
      const named = [segmentOf(span.state ?? "", name, size), segmentOf(span.row ?? "", name, size)]
        .map(text => options.filter(outfit => text.includes(outfit.name)).sort((a, b) => text.indexOf(a.name) - text.indexOf(b.name))[0])
        .find(Boolean);
      const outfit = named?.name ?? worn.get(name) ?? options[0]?.name ?? "";
      worn.set(name, outfit);
      return [name, outfit];
    }));
    return {
      shot: span.shot, time: `${seconds(span.start)}–${seconds(span.end)}s`, state: span.state, row: span.row, outfits,
      place: (assets.places.find(item => span.row?.includes(item.name)) ?? assets.places[0])?.name,
    };
  });
}

/** The part of a state or row cell about one person: from "Name:" to the next semicolon, or all of it for one person. */
function segmentOf(text: string, name: string, castSize: number) {
  const part = text.split(/[\uFF1B;]/).find(item => item.trimStart().startsWith(name));
  return part ?? (castSize === 1 ? text : "");
}

const byName = (list: ProductionAsset[], name?: string) => list.find(item => item.name === name);

// H3 takes at most 9 reference images and 4 LoRAs: 8 people and the place, of whom the first 4 with LoRAs keep theirs.
const maxPeople = 8;
export const maxLoras = 4;

/**
 * The references a shot's clip gets, in prompt order: each person the previs shows, those in the opening first, in the
 * outfit they wear in the shot, then the place. They follow the plan, not the drawing, so prompts written while the
 * designs are still drawn number the same pictures the render sends; an image is the design's view once it is drawn.
 */
export function shotReferences(shot: ProductionShot, assets: NonNullable<Production["assets"]>, framed: { opening: string[]; shown: string[] }) {
  const names = [...new Set([...framed.opening, ...framed.shown])];
  const persons = names.flatMap(name => byName(assets.characters, name) ?? []).slice(0, maxPeople);
  const outfitView = (person: ProductionAsset) => (person.outfits?.find(outfit => outfit.name === shot.outfits[person.name]) ?? person.outfits?.[0])?.views?.[0] ?? person.base;
  const place = byName(assets.places, shot.place);
  return { people: persons.map(person => ({ person, image: outfitView(person) })), place: place ? { place, image: place.views?.[0] ?? place.base } : undefined };
}

/** The reference images in prompt order, once every one is drawn. */
export function referenceImages(references: ReturnType<typeof shotReferences>) {
  const images = [...references.people.map(entry => entry.image), ...references.place ? [references.place.image] : []];
  if (images.some(image => !image)) throw new Error("A clip's reference images are not drawn yet");
  return images as string[];
}
