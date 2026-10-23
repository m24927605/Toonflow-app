import { createHash } from "node:crypto";
import { z } from "zod";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, replaceShotCells, shotSpans } from "@toonflow/node-shared/shotList";
import { parseDialogue, shotDialogue } from "@toonflow/node-shared/videoPrompt";
import { replyJson } from "./review";
import type { Production } from "./state";

const text = z.string().trim().min(1).max(1000);
const planSchema = z.strictObject({
  voices: z.array(z.strictObject({
    name: text, presentation: z.enum(["feminine", "masculine", "androgynous"]),
    description: text.max(450).regex(/^[^\r\n\[\]<>]+$/),
    language: z.string().min(2).max(64).refine(value => {
      try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
    }, "Use a BCP 47 spoken language tag, for example zh-TW or ja-JP"),
    sample: text.min(35),
  })),
  shots: z.array(z.strictObject({
    shot: z.number().int().positive(),
    place: text,
    actors: z.array(z.strictObject({
      name: text, gaze: z.enum(["screenLeft", "screenRight", "camera", "down", "up", "away"]),
      pose: text, props: z.array(text), outfit: text,
    })),
    lines: z.array(z.strictObject({ speaker: text, words: text, start: z.number().finite().nonnegative() })),
  })).min(1),
});
export type ProductionPlan = z.infer<typeof planSchema> & { source: string };
export const planJsonSchema = z.toJSONSchema(planSchema) as Record<string, unknown>;

export const gazeDescriptions = { screenLeft: "toward the left of the frame", screenRight: "toward the right of the frame", camera: "directly at the camera", down: "downward", up: "upward", away: "away from the camera" };

const speakerLabelsSchema = z.strictObject({ shots: z.array(z.strictObject({ shot: z.number().int().positive(), dialogue: z.string().min(1).max(10000) })).min(1) });
export const speakerLabelsJsonSchema = z.toJSONSchema(speakerLabelsSchema);

export function missingSpeakerLabels(shotList: string) {
  return shotSpans(checkScript(shotList).shots, shotList).filter(span => castNames(span).length !== 1 && parseDialogue(span.dialogue).some(line => !line.speaker));
}

/** Apply only speaker prefixes; retain the original words, performance notes and other cells. */
export function applySpeakerLabels(reply: string, shotList: string, known: ReadonlySet<string>) {
  const missing = missingSpeakerLabels(shotList);
  const { shots } = speakerLabelsSchema.parse(replyJson(reply, "shots"));
  if (shots.length !== missing.length || shots.some((shot, index) => shot.shot !== missing[index]!.shot)) throw new Error("Speaker correction must cover only the unresolved shots in order");
  for (const [index, shot] of shots.entries()) {
    const original = missing[index]!.dialogue!;
    const before = parseDialogue(original);
    const after = parseDialogue(shot.dialogue);
    if (before.length !== after.length || before.some((line, i) => line.words !== after[i]!.words || line.speaker && line.speaker !== after[i]!.speaker) || after.some(line => !line.speaker || !known.has(line.speaker))) throw new Error("Speaker correction changed words, order, an existing speaker or used an unknown character");
    const oldParts = original.split(/([;；])/);
    const newParts = shot.dialogue.split(/([;；])/);
    if (oldParts.length !== newParts.length) throw new Error("Speaker correction changed dialogue separators");
    let additions = 0;
    for (const [part, value] of oldParts.entries()) {
      const updated = newParts[part]!.trim();
      if (updated === value.trim()) continue;
      const speaker = [...known].find(name => updated.startsWith(`${name}:`) || updated.startsWith(`${name}：`));
      if (part % 2 || !speaker || updated.slice(speaker.length + 1).trimStart() !== value.trim()) throw new Error("Speaker correction must only add character labels");
      additions++;
    }
    if (additions !== before.filter(line => !line.speaker).length) throw new Error("Speaker correction changed performance notes or added extra labels");
  }
  const corrections = new Map(shots.map(shot => [shot.shot, shot.dialogue]));
  const checked = checkScript(shotList);
  return replaceShotCells(checked.shots, shotList, "dialogue", shotSpans(checked.shots, shotList).map(span => corrections.get(span.shot)));
}

export const planSource = (script: string, shotList: string, assets: Production["assets"]) =>
  createHash("sha256").update(JSON.stringify([script, shotList, assets?.characters.map(({ name, look, photo, outfits }) => ({ name, look, photo, outfits: outfits?.map(({ name, look }) => ({ name, look })) })), assets?.places.map(({ name, look }) => ({ name, look }))])).digest("hex");

const voiceAuditionInstructions = "sample is a natural 8–12 second audition of two complete sentences in the selected spoken language, at least 35 characters, without stage directions. Leave margin above the measured 5-second minimum: a 20-character Chinese sentence can finish too quickly. Expand a short film line into a separate complete audition; never use a two-word line as the whole audition. This sample is for casting, never added to the film. Independent neutral audition text is allowed: it need not repeat film dialogue, events or duration. Written audition words do not prove audible gender, age, timbre, accent or performance quality.";

export function planPrompt(script: string, shotList: string, assets: Production["assets"]) {
  return [
    "Compile a production contract from this screenplay and shot list. Do not invent or change events. Output only JSON matching the supplied schema.",
    `Authoritative performing-character IDs: ${JSON.stringify(assets?.characters.map(person => person.name) ?? [])}. Ordinary products and props are not actors. A product-only shot has an empty actors array. Preserve named props in the opening description and actor props where relevant.`,
    "voices: every speaking character exactly once. presentation is the intended performed voice: feminine, masculine or androgynous, consistent with the character. Describe its age, timbre and delivery explicitly in English. language MUST be a BCP 47 spoken language/dialect tag, such as zh-TW (Taiwan Mandarin), zh-CN, en-US or ja-JP, never 'Traditional Chinese' (a writing system).",
    voiceAuditionInstructions,
    "shots: every shot exactly once in shot-list order. place: the exact name of its environment asset, inferred from the screenplay's scene heading when the row omits it. actors: exactly the visible cast, named identically; gaze is the side of the SCREEN (not the actor's own left/right). pose and props describe the OPENING state, in English; outfit is its exact asset outfit name. lines: copy each dialogue's speaker and words exactly and in order. start is the line's start in seconds relative to this shot; follow explicit timing in the row, otherwise choose a natural start. Leave room for the spoken words before the shot ends. Do not put timestamps into the dialogue text.",
    "gaze: use camera when the actor looks directly into the lens; screenLeft/screenRight mean looking away from the lens toward that screen edge. Never substitute screenLeft for camera. A line's absolute film start is the shot's start plus its local start, so a line beginning at film second 1 in a shot beginning at second 1 has local start 0.",
    `Available assets: ${JSON.stringify(assets)}`,
    `Screenplay:\n${script}\nShot list:\n${shotList}`,
  ].join("\n\n");
}

export function readPlan(reply: string, script: string, shotList: string, assets: NonNullable<Production["assets"]>): ProductionPlan {
  const plan = planSchema.parse(replyJson(reply, "shots"));
  if (new Set(assets.characters.map(person => person.name)).size !== assets.characters.length || new Set(assets.places.map(place => place.name)).size !== assets.places.length) throw new Error("Character and environment IDs must be unique");
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  if (plan.shots.length !== spans.length) throw new Error("Production contract must cover every shot exactly once");
  const speakers = new Set<string>();
  for (const [index, shot] of plan.shots.entries()) {
    const span = spans[index]!;
    if (shot.shot !== span.shot) throw new Error("Production contract changed shot order or IDs");
    if (!assets.places.some(place => place.name === shot.place)) throw new Error(`Shot ${shot.shot}: unknown environment`);
    const cast = castNames(span);
    if (new Set(shot.actors.map(actor => actor.name)).size !== cast.length || shot.actors.length !== cast.length || cast.some(name => !shot.actors.some(actor => actor.name === name))) throw new Error(`Shot ${shot.shot}: contract cast differs from the shot list. Expected ${JSON.stringify(cast)}; received ${JSON.stringify(shot.actors.map(actor => actor.name))}`);
    for (const actor of shot.actors) {
      const person = assets.characters.find(person => person.name === actor.name);
      if (!person?.outfits?.some(outfit => outfit.name === actor.outfit)) throw new Error(`Shot ${shot.shot}: unknown character or outfit for ${actor.name}`);
    }
    const dialogue = shotDialogue(span);
    if (dialogue.length !== shot.lines.length || dialogue.some((line, i) => line.speaker !== shot.lines[i]!.speaker || line.words !== shot.lines[i]!.words)) throw new Error(`Shot ${shot.shot}: contract changed dialogue or its speaker/order`);
    for (const [i, line] of shot.lines.entries()) {
      if (!assets.characters.some(person => person.name === line.speaker) || line.start >= span.end - span.start || i > 0 && line.start <= shot.lines[i - 1]!.start) throw new Error(`Shot ${shot.shot}: invalid speaker or dialogue timing`);
      speakers.add(line.speaker);
    }
  }
  if (plan.voices.length !== speakers.size || new Set(plan.voices.map(voice => voice.name)).size !== speakers.size || plan.voices.some(voice => !speakers.has(voice.name))) throw new Error("Every speaking character needs exactly one voice design");
  return { ...plan, source: planSource(script, shotList, assets) };
}

export function requireCurrentPlan(production: Production, script: string, shotList: string) {
  if (!production.plan || production.plan.source !== planSource(script, shotList, production.assets)) throw new Error("Production sources changed: rebuild the contract and dependent assets before continuing");
  planSchema.extend({ source: z.string() }).parse(production.plan);
  return production.plan;
}

