import { translate, type MessageDescriptor } from "@toonflow/i18n";
import { keyframeDescriptionInstructions, keyframeTemplate, masterLine, stateLine, type PromptLine } from "@toonflow/node-shared/keyframePrompt";
import { withTriggers } from "@toonflow/node-shared/loraTriggers";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans, suggestMasterShot } from "@toonflow/node-shared/shotList";
import { generateMedia } from "@/utils/media/generation";
import { productionDirectory, type Production, type ProductionAsset } from "./state";

export type ProductionKeyframe = {
  /** `row` is the shot's shot-list row, the description's fallback when the model skipped the shot. */
  shot: number; time: string; cast: string[]; state?: string; place?: string; row?: string;
  description?: string; prompt?: string; references?: string[]; loras?: { path: string; strength: number }[]; image?: string;
};

const english = (line: PromptLine | MessageDescriptor) => typeof line === "string" ? line : translate(line, undefined, "en");
const seconds = (value: number) => Number(value.toFixed(2));

/** One keyframe per shot of the shot list, with the people of its cast cell and the place its row names (or the only one). */
export function planKeyframes(shotList: string, assets: NonNullable<Production["assets"]>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const people = new Set(assets.characters.map(item => item.name));
  const shots: ProductionKeyframe[] = spans.map(span => ({
    shot: span.shot, time: `${seconds(span.start)}–${seconds(span.end)}s`, state: span.state, row: span.row,
    cast: castNames(span).filter(name => people.has(name)),
    place: (assets.places.find(item => span.row?.includes(item.name)) ?? assets.places[0])?.name,
  }));
  return { master: suggestMasterShot(shotList, spans)?.shot ?? 1, shots };
}

/** Asks for every shot's still-frame description in one request, as "### Shot N" sections. */
export function descriptionsPrompt(script: string, shotList: string, shots: ProductionKeyframe[]) {
  return [
    "The screenplay and its shot list are below. For every shot, follow that shot's instructions; write the sections one after another.",
    ...shots.flatMap(item => ["", ...keyframeDescriptionInstructions(item.shot, item.time, item.cast, item.state).map(english)]),
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

/**
 * The prompt, references and LoRAs of one keyframe: the place's base image, each person's front view, and the master
 * keyframe for every other shot; Qwen-Image LoRAs of the cast and place, at most 4, people first.
 */
export function composeKeyframe(item: ProductionKeyframe, assets: NonNullable<Production["assets"]>, masterImage?: string) {
  const place = byName(assets.places, item.place);
  const people = item.cast.flatMap(name => byName(assets.characters, name) ?? []);
  const references = [...place?.views?.[0] ? [place.views[0]] : [], ...people.map(person => person.views![0]!)];
  // A person's trigger word stands next to their name, so the LoRA binds to that person rather than the whole picture.
  const trigger = (asset: ProductionAsset) => asset.loras?.find(lora => lora.family === "qwen")?.trigger;
  const template = keyframeTemplate(place ? 1 : 0, people.map((person, index) => ({ name: trigger(person) ? `${person.name} (${trigger(person)})` : person.name, ref: (place ? 2 : 1) + index })));
  const fixed = [
    ...item.state ? [english(stateLine(item.state))] : [],
    ...masterImage ? [english(masterLine(`{{ref ${references.length + 1}}}`))] : [],
  ];
  const prompt = template.map(english).join("\n").replace("{{shot}}", [...fixed, item.description ?? ""].join("\n"));
  const loras = [...people, ...place ? [place] : []].flatMap(asset => (asset.loras ?? []).filter(lora => lora.family === "qwen").map(lora => ({ ...lora, name: asset.name }))).slice(0, 4);
  return {
    prompt: withTriggers(prompt, loras), references: [...references, ...masterImage ? [masterImage] : []],
    loras: loras.map(lora => ({ path: lora.path, strength: 1 })),
  };
}

export async function drawKeyframe(cwd: string, production: Production, item: ProductionKeyframe, signal: AbortSignal) {
  const [image] = await generateMedia(cwd, "image", {
    providerId: "qwenImage", modelId: "qwen_image_2_1_turbo", prompt: item.prompt!, ratio: production.input.ratio, size: "1K",
    outputDirectory: `${productionDirectory(production.id)}/keyframes`, loras: item.loras,
    images: item.references!.map(path => ({ path, mimeType: /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png" })),
  }, signal);
  return image!.path;
}
