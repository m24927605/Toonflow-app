import { z } from "zod";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotSpans } from "@toonflow/node-shared/shotList";
import { readdir, readFile } from "@toonflow/file";
import { trainLora, triggerWord, type LoraRecord } from "@/utils/media/lora";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { holdQwenImage } from "@/utils/media/qwenImage";
import { outfitView } from "./shots";
import { productionDirectory, type Production, type ProductionAsset } from "./state";

const castSchema = z.object({
  characters: z.array(z.object({
    name: z.string().trim().min(1), look: z.string().trim().min(1),
    outfits: z.array(z.object({ name: z.string().trim().min(1), look: z.string().trim().min(1), adult: z.boolean().optional() })).min(1),
  })),
  places: z.array(z.object({ name: z.string().trim().min(1), look: z.string().trim().min(1) })),
});

/**
 * Asks the screenplay for its cast and places as JSON, each with a fixed name and an English description of its look.
 * Outfits are named as the shot list's state cells name the clothes, so every shot finds the picture of what is worn
 * there, a garment taken off included.
 */
export function castPrompt(script: string, shotList: string) {
  return [
    "List every character and every place of the screenplay below as JSON, exactly in this shape:",
    "{\"characters\":[{\"name\":\"...\",\"look\":\"...\",\"outfits\":[{\"name\":\"...\",\"look\":\"...\",\"adult\":false}]}],\"places\":[{\"name\":\"...\",\"look\":\"...\"}]}",
    "name: exactly as the screenplay writes it, without any reading or translation in brackets. A person's look: one English sentence of their apparent age, ethnicity, build, face and hair (fitting where the story is set), without clothing. outfits: every set of clothes the person wears in the story, in order, each with the short name the screenplay uses (or a short one in its language) and one English sentence describing it; a person who is unclothed in a scene has an outfit for that too; adult: true for an outfit that leaves the person nude or partly nude, or that the screenplay uses in a sexual scene, else false. The shot list after the screenplay gives what each person wears in each shot in its State column: every different set of clothes a State cell gives a person is one of their outfits, named exactly as that cell writes the clothes, and a change such as a jacket taken off or put on is an outfit of its own, described with that garment gone or added. A place's look: one English sentence of its architecture, materials, furniture and light, and of the props the people handle there, set where the story first finds them, such as a tea set on a table. Do not use quotation marks inside the sentences.",
    "Output only the JSON.",
    "",
    "Screenplay:",
    script,
    "",
    "Shot list:",
    shotList,
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
// Adult outfits are drawn with the slower photographic recipe of the base model, which Turbo's distilled style lacks.
const photo = "qwen_image_2_1_photo";
const finish = "Photorealistic, sharp focus, natural texture, one single photograph, no text.";
const studio = "plain light grey studio background, even soft light";

// A person's face close-ups, drawn once from their base image, and the full-body views drawn for every outfit; the
// first outfit view, facing the camera, is the reference image clips use.
const faceViews: [ratio: string, view: string][] = [
  ["1:1", `Tight close-up of the face, front view, neutral expression, ${studio}.`],
  ["1:1", `Close-up of the face in three-quarter view, slight smile, ${studio}.`],
];
const outfitViews: [ratio: string, view: string][] = [
  ["2:3", `Full-body shot facing the camera, standing, arms relaxed, ${studio}.`],
  ["2:3", `Full-body shot in three-quarter view facing left, standing, ${studio}.`],
  ["2:3", `Full-body back view, standing, ${studio}.`],
];
// Places keep the base image's side: views it does not show would be invented and teach a different room. Its props
// stay in every view, so each clip finds the same teapot rather than inventing its own.
const placeViews = [
  "The same place seen a little closer from the same side, with the same furniture and props, no people.",
  "The left part of the same place seen closer from the same side, with the same furniture and props, no people.",
];

async function draw(cwd: string, id: string, prompt: string, ratio: string, references: string[], signal: AbortSignal, modelId = qwen.modelId) {
  const [image] = await generateMedia(cwd, "image", {
    ...qwen, modelId, prompt, ratio, size: "1K", outputDirectory: `${productionDirectory(id)}/assets`,
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
        const outfit = item.outfits![0]!;
        item.base = item.photo ?? await draw(cwd, production.id, `Full-body photograph of ${item.look}, wearing ${outfit.look}, standing facing the camera, ${studio}. ${finish}`, "2:3", [], signal, outfit.adult ? photo : undefined);
      }),
      ...assets.places.filter(item => !item.base).map(async item => {
        item.base = await draw(cwd, production.id, `Wide shot of ${item.look}, no people. ${finish}`, ratio, [], signal);
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
        outfit.views = await Promise.all(outfitViews.map(([viewRatio, view]) => draw(cwd, production.id, `${view} ${rule} ${finish}`, viewRatio, [item.base!], signal, outfit.adult ? photo : undefined)));
      })),
      ...assets.places.filter(item => !item.views).map(async item => {
        const rule = "The place is exactly the one shown in {{ref 1}}: the same architecture, materials, furniture, props, layout and light.";
        item.views = [item.base!, ...await Promise.all(placeViews.map(view => draw(cwd, production.id, `${view} ${rule} ${finish}`, ratio, [item.base!], signal)))];
      }),
    ]);
    await save();
  } finally {
    release();
  }
}

const poseModel = "qwen_image_2_1_pose";
const poseRatios = [[1, 1], [3, 4], [2, 3], [9, 16], [4, 3], [3, 2], [16, 9]] as const;

/** The supported ratio closest to a PNG's own, read from its header. */
async function ratioOf(cwd: string, path: string) {
  const header = await readFile((await resolveWorkspacePath(cwd, path)).path).then(data => data.subarray(16, 24));
  const aspect = header.readUInt32BE(0) / header.readUInt32BE(4);
  const [width, height] = poseRatios.reduce((best, ratio) => Math.abs(Math.log(ratio[0] / ratio[1] / aspect)) < Math.abs(Math.log(best[0] / best[1] / aspect)) ? ratio : best);
  return `${width}:${height}`;
}

/**
 * Draws every person of each shot's opening in the outfit they wear there and in their pose in the previs: pose
 * transfer puts the person of their outfit's front view into the pose of their full-body previs figure, so the clip's
 * reference shows them kneeling, seated or turned as the shot begins rather than standing facing the camera. The front
 * view looks into the lens and the figure's featureless head barely shows a turn, so the prompt says which way the head
 * and eyes turn, or the drawn person stares at the viewer and the clip copies the stare. Requests go out together, so
 * Qwen-Image draws them in one batch. A person without a pose render keeps the front view.
 * ACT: Each pose costs well under a minute of the Qwen machine, left out of the production estimate.
 */
export async function drawPoses(cwd: string, production: Production, signal: AbortSignal, save: () => Promise<void>) {
  await Promise.all(production.previs!.flatMap(previs => Object.entries(previs.poses ?? {}).map(async ([name, render]) => {
    const shot = production.shots!.find(item => item.shot === previs.shot)!;
    const person = production.assets!.characters.find(item => item.name === name);
    const view = person && outfitView(person, shot);
    if (shot.poses?.[name] || !view) return;
    const look = previs.framed.looks[name];
    const posed = await draw(cwd, production.id, `${look ? `The person is ${look}. ` : ""}${finish}`, await ratioOf(cwd, render), [render, view], signal, poseModel);
    (shot.poses ??= {})[name] = posed;
  })));
  await save();
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
// person or place, with the same 1.3 margin as the production estimate; scaled since by the character recipe, about
// 1500 steps instead of about 1200 and up to 25 drawn variants instead of 11.
const unitsPerFamily = 1.54 * 1.3 * 1.25;
const unitsPerTopUp = 6.77 / 6 * 1.3 * 25 / 11;

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
    // Only the video model takes LoRAs: clips get people and places as reference images, so a person needs an H3 LoRA to
    // keep their face and a place none.
    ...assets.characters.map(item => ({ item, kind: "character" as const, families: ["h3"] as ("h3" | "qwen")[], shots: counts.people.get(item.name) ?? 0 })),
    ...assets.places.map(item => ({ item, kind: "scene" as const, families: [] as ("h3" | "qwen")[], shots: counts.places.get(item.name) ?? 0 })),
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

/** How many of these people already have their H3 character LoRA, which a production reuses. */
export async function peopleWithLoras(cwd: string, names: string[]) {
  const records = await workspaceLoras(cwd);
  const ready = (name: string) => records.some(record => record.kind === "character" && record.family === "h3" && record.name === name);
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
