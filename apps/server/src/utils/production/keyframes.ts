import { translate, type MessageDescriptor } from "@toonflow/i18n";
import { keyframeDescriptionInstructions, keyframeTemplate, masterLine, stateLine, type PromptLine } from "@toonflow/node-shared/keyframePrompt";
import { withTriggers } from "@toonflow/node-shared/loraTriggers";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans, suggestMasterShot } from "@toonflow/node-shared/shotList";
import { generateMedia } from "@/utils/media/generation";
import { productionDirectory, type Production, type ProductionAsset } from "./state";

export type ProductionKeyframe = {
  /** `row` is the shot's shot-list row, the description's fallback when the model skipped the shot. */
  shot: number; time: string; state?: string; place?: string; row?: string;
  /** The outfit each person wears in the shot, by name; everyone has one, as the previs may show anyone. */
  outfits?: Record<string, string>;
  description?: string; prompt?: string; references?: string[]; loras?: { path: string; strength: number }[]; image?: string;
  /** The first stage of the keyframe, drawn from the previs depth map without reference images, and its prompt. */
  draft?: string; draftPrompt?: string;
  /** The seed the keyframe was drawn with, kept so a redraw after a change request changes only what was asked. */
  seed?: number;
};

const english = (line: PromptLine | MessageDescriptor) => typeof line === "string" ? line : translate(line, undefined, "en");
const seconds = (value: number) => Number(value.toFixed(2));

/**
 * One keyframe per shot of the shot list, with the place its row names (or the only one) and everyone's outfit; who is
 * in it comes from the shot's previs.
 */
export function planKeyframes(shotList: string, assets: NonNullable<Production["assets"]>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const people = new Set(assets.characters.map(item => item.name));
  // Each person wears the outfit the shot's state (or else its row) names, or else what they wore in their last shot,
  // or else their first outfit, so clothes only change where the shot list says so.
  const worn = new Map<string, string>();
  const shots: ProductionKeyframe[] = spans.map(span => {
    const cast = castNames(span).filter(name => people.has(name));
    const outfits = Object.fromEntries(assets.characters.map(({ name, outfits: options = [] }) => {
      // Within the person's part of the state ("日男：…；"), the outfit named first is the one worn: "白襯衫（已脫下西裝外套）".
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
  return { master: suggestMasterShot(shotList, spans)?.shot ?? 1, shots };
}

/** Asks for every shot's still-frame description in one request, as "### Shot N" sections, each placing people as the shot's previs does. */
export function descriptionsPrompt(script: string, shotList: string, shots: ProductionKeyframe[], previs: NonNullable<Production["previs"]>) {
  return [
    "The screenplay and its shot list are below. For every shot, follow that shot's instructions; write the sections one after another.",
    ...shots.flatMap(item => {
      const { framed, blocking } = previs.find(shot => shot.shot === item.shot)!;
      return ["", ...keyframeDescriptionInstructions(item.shot, item.time, framed.opening, item.state, blocking).map(english)];
    }),
    "",
    "Screenplay:",
    script,
    "",
    "Shot list:",
    shotList,
  ].join("\n");
}

export function parseDescriptions(text: string) {
  const sections = new Map<number, string>();
  for (const match of text.matchAll(/^#{2,4}\s*Shot\s*(\d+)\s*\n([\s\S]*?)(?=^#{2,4}\s*Shot\s*\d+|$(?![\s\S]))/gim)) {
    sections.set(Number(match[1]), match[2]!.trim());
  }
  return sections;
}

const byName = (list: ProductionAsset[], name?: string) => list.find(item => item.name === name);

/** The part of a state or row cell about one person: from "Name:" to the next semicolon, or all of it for one person. */
function segmentOf(text: string, name: string, castSize: number) {
  const part = text.split(/[；;]/).find(item => item.trimStart().startsWith(name));
  return part ?? (castSize === 1 ? text : "");
}

/**
 * The prompts, references and LoRAs of one keyframe: the shot's previs depth map first, which fixes the composition
 * through the depth model, then the place's base image, the front view of each person the previs shows in the opening
 * and, for every other shot, the master keyframe, which set the look; Qwen-Image LoRAs of those people and the place, at
 * most 4, people first. The draft's prompt points at no reference image: it names each person by their trigger word
 * with their look and clothes, and the place by its look, in full sentences, since short "X is Y." lines came out as
 * text in the picture.
 */
export function composeKeyframe(item: ProductionKeyframe, assets: NonNullable<Production["assets"]>, previs: NonNullable<Production["previs"]>[number], masterImage?: string) {
  const set = byName(assets.places, item.place);
  const setView = set?.views?.[0];
  const people = previs.framed.opening.flatMap(name => byName(assets.characters, name) ?? []);
  const depth = previs.depth!;
  const outfitOf = (person: ProductionAsset) => person.outfits?.find(outfit => outfit.name === item.outfits?.[person.name]) ?? person.outfits?.[0];
  // A person's reference is the front view of the outfit they wear in this shot, so the keyframe draws those clothes.
  const outfitView = (person: ProductionAsset) => outfitOf(person)?.views?.[0] ?? person.base!;
  // {{ref 1}} is the depth map, which the depth model takes as its control image, so the look references start at 2.
  const references = [depth, ...setView ? [setView] : [], ...people.map(outfitView)];
  // A person's trigger word stands next to their name, so the LoRA binds to that person rather than the whole picture.
  const trigger = (asset: ProductionAsset) => asset.loras?.find(lora => lora.family === "qwen")?.trigger;
  const template = keyframeTemplate(setView ? [2] : [], people.map((person, index) => ({ name: trigger(person) ? `${person.name} (${trigger(person)})` : person.name, ref: (setView ? 3 : 2) + index })));
  const fixed = [
    ...item.state ? [english(stateLine(item.state))] : [],
    ...masterImage ? [english(masterLine(`{{ref ${references.length + 1}}}`))] : [],
  ];
  const prompt = template.map(english).join("\n").replace("{{shot}}", [...fixed, item.description ?? ""].join("\n"));
  const loras = [...people, ...set ? [set] : []].flatMap(asset => (asset.loras ?? []).filter(lora => lora.family === "qwen").map(lora => ({ ...lora, name: asset.name }))).slice(0, 4);
  const look = (person: ProductionAsset) => `${person.look} ${outfitOf(person)?.look ?? ""}`.trim();
  const draftPrompt = [
    "One single photorealistic film still, not a collage.",
    ...set ? [`The place: ${set.look}`] : [],
    ...people.length ? [`The people in the frame: ${people.map(person => trigger(person) ? `${person.name} is ${trigger(person)}: ${look(person)}` : `${person.name}: ${look(person)}`).join(" ")}`] : [],
    ...item.state ? [`Their state at the start of this shot: ${item.state}.`] : [],
    item.description ?? "",
    "Natural skin, sharp focus. The picture contains no text, no captions, no letters and no watermark.",
  ].join("\n");
  return {
    prompt: withTriggers(prompt, loras), draftPrompt: withTriggers(draftPrompt, loras), references: [...references, ...masterImage ? [masterImage] : []],
    loras: loras.map(lora => ({ path: lora.path, strength: 1 })),
  };
}

// How much of a draft its redraw changes: on two-person, single and close shots, 0.927 barely took the references' set
// and clothes, and 0.978 lost the draft's composition.
const keyframeRedraw = 0.954;
const imageReference = (path: string) => ({ path, mimeType: /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png" });

/**
 * Draws a keyframe's draft from its previs depth map alone, since the model copies the layout of reference images and
 * would drop the previs composition; with the keyframe's own seed when it has one, and returns the seed it drew with.
 */
export async function drawDraft(cwd: string, production: Production, item: ProductionKeyframe, signal: AbortSignal) {
  const [image] = await generateMedia(cwd, "image", {
    providerId: "qwenImage", modelId: "qwen_image_2_1_turbo_depth", prompt: item.draftPrompt!, ratio: production.input.ratio, size: "1K",
    outputDirectory: `${productionDirectory(production.id)}/keyframes`, loras: item.loras, seed: item.seed,
    images: [imageReference(item.references![0]!)],
  }, signal);
  return { draft: image!.path, seed: image!.seed };
}

/** Redraws a keyframe's draft with its references and seed, keeping the draft's composition and taking their look. */
export async function drawKeyframe(cwd: string, production: Production, item: ProductionKeyframe, signal: AbortSignal) {
  const [image] = await generateMedia(cwd, "image", {
    providerId: "qwenImage", modelId: "qwen_image_2_1_turbo_depth", prompt: item.prompt!, ratio: production.input.ratio, size: "1K",
    outputDirectory: `${productionDirectory(production.id)}/keyframes`, loras: item.loras, seed: item.seed,
    images: item.references!.map(imageReference), initImage: imageReference(item.draft!), denoise: keyframeRedraw,
  }, signal);
  return { image: image!.path, seed: image!.seed };
}

/** Asks for new descriptions of only the shots a reviewer's change requests concern, as "### Shot N" sections. */
export function keyframeRevisionPrompt(shots: ProductionKeyframe[], notes: string) {
  return [
    "A reviewer asked for changes to the keyframes of a short film. The change requests and every shot's current still-frame description are below.",
    "Rewrite the description of each shot the requests concern, changing only what they ask and keeping the rest word for word; when a request concerns something every shot shares, such as the light or someone's clothes, rewrite every shot it affects.",
    "Output only the rewritten shots, each as the heading line \"### Shot N\" followed by its paragraph, and nothing for a shot that stays as it is.",
    "",
    "Change requests:",
    notes,
    "",
    ...shots.flatMap(item => [`### Shot ${item.shot}`, item.description ?? "", ""]),
  ].join("\n");
}
