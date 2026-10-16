import { z } from "zod";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { readdir, readFile } from "@toonflow/file";
import { trainLora, triggerWord, type LoraRecord } from "@/utils/media/lora";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { holdQwenImage } from "@/utils/media/qwenImage";
import { productionDirectory, type Production, type ProductionAsset } from "./state";

const castSchema = z.object({
  characters: z.array(z.object({
    name: z.string().trim().min(1), look: z.string().trim().min(1),
    outfits: z.array(z.object({ name: z.string().trim().min(1), look: z.string().trim().min(1) })).min(1),
  })),
  places: z.array(z.object({ name: z.string().trim().min(1), look: z.string().trim().min(1) })),
});

/** Asks the screenplay for its cast and places as JSON, each with a fixed name and an English description of its look. */
export function castPrompt(script: string) {
  return [
    "List every character and every place of the screenplay below as JSON, exactly in this shape:",
    "{\"characters\":[{\"name\":\"...\",\"look\":\"...\",\"outfits\":[{\"name\":\"...\",\"look\":\"...\"}]}],\"places\":[{\"name\":\"...\",\"look\":\"...\"}]}",
    "name: exactly as the screenplay writes it, without any reading or translation in brackets. A person's look: one English sentence of their apparent age, ethnicity, build, face and hair (fitting where the story is set), without clothing. outfits: every set of clothes the person wears in the story, in order, each with the short name the screenplay uses (or a short one in its language) and one English sentence describing it; a person who is unclothed in a scene has an outfit for that too. A place's look: one English sentence of its architecture, materials, furniture and light. Do not use quotation marks inside the sentences.",
    "Output only the JSON.",
    "",
    "Screenplay:",
    script,
  ].join("\n");
}

/** Reads the cast the model listed, adding the people the user gave photos of, by name. */
export function parseCast(text: string, photos: Production["input"]["photos"]) {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) throw new Error("The model did not list the cast as JSON");
  const cast = castSchema.parse(JSON.parse(json));
  // Models add readings or translations in brackets, such as 日女 (Nichi-onna); the shot list's cast uses the bare name.
  const bare = <T extends { name: string }>(item: T) => ({ ...item, name: item.name.replace(/\s*[(（][^)）]*[)）]\s*$/, "").trim() || item.name });
  const characters: ProductionAsset[] = cast.characters.map(bare).map(item => ({ ...item, photo: photos.find(photo => photo.name === item.name)?.path }));
  // Someone with a photo but no part in the script keeps the clothes of the photo.
  for (const photo of photos) {
    if (!characters.some(item => item.name === photo.name)) characters.push({ name: photo.name, look: "the person in the photo", photo: photo.path, outfits: [{ name: "photo", look: "exactly the clothes shown in the photo" }] });
  }
  return { characters, places: cast.places.map(bare) };
}

const qwen = { providerId: "qwenImage", modelId: "qwen_image_2_1_turbo" };
const finish = "Photorealistic, sharp focus, natural texture, one single photograph, no text.";
const studio = "plain light grey studio background, even soft light";

// A person's face close-ups, drawn once from their base image, and the full-body views drawn for every outfit; the
// first outfit view, facing the camera, is the reference keyframes use.
const faceViews: [ratio: string, view: string][] = [
  ["1:1", `Tight close-up of the face, front view, neutral expression, ${studio}.`],
  ["1:1", `Close-up of the face in three-quarter view, slight smile, ${studio}.`],
];
const outfitViews: [ratio: string, view: string][] = [
  ["2:3", `Full-body shot facing the camera, standing, arms relaxed, ${studio}.`],
  ["2:3", `Full-body shot in three-quarter view facing left, standing, ${studio}.`],
  ["2:3", `Full-body back view, standing, ${studio}.`],
];
// Places keep the base image's side: views it does not show would be invented and teach a different room.
const placeViews = [
  "The same place seen a little closer from the same side, empty.",
  "The left part of the same place seen closer from the same side, empty.",
];

async function draw(cwd: string, id: string, prompt: string, ratio: string, references: string[], signal: AbortSignal) {
  const [image] = await generateMedia(cwd, "image", {
    ...qwen, prompt, ratio, size: "1K", outputDirectory: `${productionDirectory(id)}/assets`,
    images: references.map(path => ({ path, mimeType: /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.webp$/i.test(path) ? "image/webp" : "image/png" })),
  }, signal);
  return image!.path;
}

/**
 * Draws the base image of every character without a photo and of every place in one batch, then every view in a
 * second batch: Qwen-Image draws requests that arrive together in one Colab session, and the session is held between
 * the two batches so they share one machine.
 */
export async function drawAssets(cwd: string, production: Production, ratio: string, signal: AbortSignal, save: () => Promise<void>) {
  const assets = production.assets!;
  const release = holdQwenImage();
  try {
    await Promise.all([
      ...assets.characters.filter(item => !item.base).map(async item => {
        item.base = item.photo ?? await draw(cwd, production.id, `Full-body photograph of ${item.look}, wearing ${item.outfits![0]!.look}, standing facing the camera, ${studio}. ${finish}`, "2:3", [], signal);
      }),
      ...assets.places.filter(item => !item.base).map(async item => {
        item.base = await draw(cwd, production.id, `Wide shot of ${item.look}, empty, no people. ${finish}`, ratio, [], signal);
      }),
    ]);
    await save();
    await Promise.all([
      ...assets.characters.filter(item => !item.views).map(async item => {
        const rule = "The person is exactly the one shown in {{ref 1}}: the same face, eyes, nose, lips, skin tone, hairstyle and body.";
        item.views = await Promise.all(faceViews.map(([viewRatio, view]) => draw(cwd, production.id, `${view} ${rule} ${finish}`, viewRatio, [item.base!], signal)));
      }),
      ...assets.characters.flatMap(item => (item.outfits ?? []).filter(outfit => !outfit.views).map(async outfit => {
        const rule = `The person is exactly the one shown in {{ref 1}}: the same face, eyes, nose, lips, skin tone, hairstyle and body, now wearing ${outfit.look}.`;
        outfit.views = await Promise.all(outfitViews.map(([viewRatio, view]) => draw(cwd, production.id, `${view} ${rule} ${finish}`, viewRatio, [item.base!], signal)));
      })),
      ...assets.places.filter(item => !item.views).map(async item => {
        const rule = "The place is exactly the one shown in {{ref 1}}: the same architecture, materials, furniture, layout and light.";
        item.views = [item.base!, ...await Promise.all(placeViews.map(view => draw(cwd, production.id, `${view} ${rule} ${finish}`, ratio, [item.base!], signal)))];
      }),
    ]);
    await save();
  } finally {
    release();
  }
}

// ACT: A LoRA (about 1–2 units each) only pays off for a person or place seen in this many shots; fewer get by on
// their reference images. Tune it once productions show where identity drifts.
const minShotsForLora = 3;

/**
 * In how many shots each person and place appears: people by who the shot's previs shows, which the cast cell may leave
 * out, places by name in the row (all, if one).
 */
export function appearances(shotList: string, assets: NonNullable<Production["assets"]>, previs: NonNullable<Production["previs"]>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const people = new Map(assets.characters.map(item => [item.name, previs.filter(shot => shot.framed.shown.includes(item.name)).length]));
  const places = new Map(assets.places.map(item => [item.name, assets.places.length === 1 ? spans.length : spans.filter(span => span.row?.includes(item.name)).length]));
  return { people, places };
}

// ACT: Measured per LoRA: one L4 hour of training per family and about ten A100 minutes of generated variants per
// person or place, with the same 1.3 margin as the production estimate.
const unitsPerFamily = 1.54 * 1.3;
const unitsPerTopUp = 6.77 / 6 * 1.3;

/**
 * Which LoRAs each person and place gets: none when seen in too few shots, the workspace's own LoRA of the same name
 * when it has one, else trained for the missing families. Each LoRA's trigger word is fixed the first time it is
 * planned, the reused LoRA's own or a new one it is then trained with, and kept on the asset, so texts can name it
 * while it trains. `units` is what the training will cost.
 */
export async function planAssetLoras(cwd: string, production: Production, shotList: string) {
  const assets = production.assets!;
  const counts = appearances(shotList, assets, production.previs!);
  const existing = await workspaceLoras(cwd);
  const jobs = [
    ...assets.characters.map(item => ({ item, kind: "character" as const, families: ["h3", "qwen"] as const, shots: counts.people.get(item.name) ?? 0 })),
    ...assets.places.map(item => ({ item, kind: "scene" as const, families: ["qwen"] as const, shots: counts.places.get(item.name) ?? 0 })),
  ].filter(job => !job.item.loras).map(({ item, kind, families, shots }) => {
    if (shots < minShotsForLora) return { item, kind, kept: [] as LoraRecord[], missing: [] as ("h3" | "qwen")[] };
    item.triggers ??= Object.fromEntries(families.map(family =>
      [family, existing.find(record => record.kind === kind && record.family === family && record.name === item.name)?.trigger ?? triggerWord()]));
    const kept = existing.filter(record => record.trigger === item.triggers![record.family]);
    return { item, kind, kept, missing: families.filter(family => !kept.some(record => record.family === family)) };
  });
  const units = jobs.reduce((sum, job) => sum + (job.missing.length ? job.missing.length * unitsPerFamily + unitsPerTopUp : 0), 0);
  return { jobs, units };
}

/** Trains the planned LoRAs all at once; Colab hands out the L4s as they free up. */
export async function trainAssetLoras(cwd: string, plan: Awaited<ReturnType<typeof planAssetLoras>>, signal: AbortSignal, save: () => Promise<void>) {
  await Promise.all(plan.jobs.map(async ({ item, kind, kept, missing }) => {
    const trained = missing.length ? await trainLora(cwd, { kind, families: missing, name: item.name, items: assetViews(item).map(path => ({ path })), triggers: item.triggers }, signal) : [];
    item.loras = [...kept, ...trained].map(record => ({ family: record.family, path: record.path, trigger: record.trigger }));
    await save();
  }));
}

/** How many of these people already have both their H3 and Qwen-Image character LoRAs, which a production reuses. */
export async function peopleWithLoras(cwd: string, names: string[]) {
  const records = await workspaceLoras(cwd);
  const ready = (name: string) => (["h3", "qwen"] as const).every(family => records.some(record => record.kind === "character" && record.family === family && record.name === name));
  return [...new Set(names.filter(Boolean))].filter(ready).length;
}

/** The workspace's LoRA records, newest first. */
async function workspaceLoras(cwd: string) {
  const folder = (await resolveWorkspacePath(cwd, "loras", true)).path;
  const names = (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
  const records = await Promise.all(names.map(name => readFile(`${folder}/${name}`, "utf8").then(text => JSON.parse(text) as LoraRecord, () => undefined)));
  return records.filter((record): record is LoraRecord => !!record?.trigger && !!record.path).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every reference image of a person or place, across outfits, as a LoRA learns them. */
export const assetViews = (item: ProductionAsset) => [...item.views ?? [], ...(item.outfits ?? []).flatMap(outfit => outfit.views ?? [])];

/** Whether every image of a person or place is drawn. */
export const assetDrawn = (item: ProductionAsset) => !!item.views && (item.outfits ?? []).every(outfit => !!outfit.views);
