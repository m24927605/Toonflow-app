import { z } from "zod";
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "@toonflow/file";
import { trainLora, triggerWord, type LoraRecord } from "@/utils/media/lora";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { holdQwenImage } from "@/utils/media/qwenImage";
import { productionDirectory, readProduction, type Production, type ProductionAsset } from "./state";

const castSchema = z.object({
  characters: z.array(z.object({
    name: z.string().trim().min(1), look: z.string().trim().min(1),
    outfits: z.array(z.object({ name: z.string().trim().min(1), look: z.string().trim().min(1) })).min(1),
  })),
  places: z.array(z.object({ name: z.string().trim().min(1), look: z.string().trim().min(1) })),
});

/** The cast reply shape as a JSON Schema, which the model's sampling is held to. */
export const castJsonSchema = z.toJSONSchema(castSchema) as Record<string, unknown>;

/**
 * Asks the screenplay for its cast and places as JSON, each with a fixed name and an English description of its look.
 * Outfits are named as the shot list's state cells name the clothes, so every shot finds the picture of what is worn
 * there, a garment taken off included.
 */
export function castPrompt(script: string, shotList: string) {
  return [
    "List every character and every place of the screenplay below as JSON, exactly in this shape:",
    "{\"characters\":[{\"name\":\"...\",\"look\":\"...\",\"outfits\":[{\"name\":\"...\",\"look\":\"...\"}]}],\"places\":[{\"name\":\"...\",\"look\":\"...\"}]}",
    "name: exactly as the screenplay writes it, without any reading or translation in brackets. A person's look: one English sentence of their apparent age, ethnicity, build, face and hair (fitting where the story is set), without clothing. outfits: every set of clothes the person wears in the story, in order, each with the short name the screenplay uses (or a short one in its language) and one English sentence describing it; a person who is unclothed in a scene has an outfit for that too. The shot list after the screenplay gives what each person wears in each shot in its State column: every different set of clothes a State cell gives a person is one of their outfits, named exactly as that cell writes the clothes, and a change such as a jacket taken off or put on is an outfit of its own, described with that garment gone or added. A place's look: one English sentence of the fixed details that identify it from any camera angle (the walls and their colour, the floor, the main furniture with its shape and colour, lamps, windows and curtains) and its light, and only the static props resting there at the opening; actor-held props belong to actor state and are excluded from the empty set. Do not use quotation marks inside the sentences.",
    "A place is an EMPTY environment: no person, body part, hand holding a prop, reflection of a person or human silhouette. Its look includes only architecture, furniture, light and static props actually resting in the environment at the opening. A prop already held or worn by an actor belongs to that actor's opening state: exclude it from the empty environment rather than placing a duplicate on a table. Never put a character's pose or action in a place description.",
    "Include static furniture required by the actions, even when only the action mentions it: a person seated at a desk needs both the desk and a chair. EMPTY removes people, not the furniture supporting them.",
    "Frame and cropping instructions describe the camera composition. Include a physical picture frame only when the story explicitly names one as a set prop.",
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
  // An outfit named twice is one set of clothes: the model lists it again for every shot that names it, which drew the
  // same clothes six times over.
  const characters: ProductionAsset[] = cast.characters.map(bare).map(item => ({
    ...item, outfits: item.outfits.filter((outfit, index) => item.outfits.findIndex(other => other.name === outfit.name) === index),
    photo: photos.find(photo => photo.name === item.name)?.path,
  }));
  // Someone with a photo but no part in the script keeps the clothes of the photo.
  for (const photo of photos) {
    if (!characters.some(item => item.name === photo.name)) characters.push({ name: photo.name, look: "the person in the photo", photo: photo.path, outfits: [{ name: "photo", look: "exactly the clothes shown in the photo" }] });
  }
  return { recipe: "b3" as const, characters, places: cast.places.map(bare) };
}

const qwen = { providerId: "qwenImage", modelId: "qwen_image_2_1" };
export const emptyEnvironmentRule = "Empty environment, no people, hands, human body parts, silhouettes or reflected people.";
const finish = "Photorealistic, sharp focus, natural texture, one single photograph, no text.";
const studio = "plain light grey studio background, even soft light";

// Identity views are independent of wardrobe views. The first outfit view supplies the shot's front reference.
const faceViews: [ratio: string, view: string][] = [
  ["1:1", `Show a tight close-up of the face, front view, neutral expression, ${studio}.`],
  ["1:1", `Show a close-up of the face in three-quarter view, slight smile, ${studio}.`],
];
const outfitViews: [ratio: string, view: string][] = [
  ["2:3", `Show a full-body view facing the camera, standing, arms relaxed, ${studio}.`],
  ["2:3", `Show a full-body three-quarter view facing left, standing, ${studio}.`],
  ["2:3", `Show a full-body back view, standing, ${studio}.`],
];
// Places keep the base image's side: views it does not show would be invented and teach a different room. Its props
// stay in every view, so each clip finds the same teapot rather than inventing its own.
const placeViews = [
  "Show a closer view of the environment from the same side.",
  "Show a closer view of the left side of the environment.",
];

async function draw(cwd: string, id: string, prompt: string, ratio: string, references: string[], signal: AbortSignal, modelId = qwen.modelId, size = "1K", folder = "assets") {
  const [image] = await generateMedia(cwd, "image", {
    ...qwen, modelId, prompt, ratio, size, outputDirectory: `${productionDirectory(id)}/${folder}`,
    images: references.map(path => ({ path, mimeType: /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.webp$/i.test(path) ? "image/webp" : "image/png" })),
  }, signal);
  return image!.path;
}

/**
 * Takes matching designs from completed films from the workspace's latest earlier production for the same person, outfit or place, so a new film
 * of the same people neither waits for them nor draws them differently: a person by name and photo (and look, when
 * drawn without a photo), an outfit of theirs by name, a place by name and look. Only designs whose files are all
 * still there are taken. Outfit descriptions must match, so a reused name cannot silently keep older clothes.
 */
async function reuseDesigns(cwd: string, production: Production) {
  if (production.execution!.reuseDesigns.mode === "new") return;
  const folder = (await resolveWorkspacePath(cwd, productionDirectory(""), true)).path;
  const ids = (await readdir(folder).catch(() => [] as string[])).filter(id => id !== production.id);
  const earlier = (await Promise.all(ids.map(id => readProduction(cwd, id).catch(() => undefined))))
    .flatMap(item => item?.assets?.recipe === "b3" && item.status === "done" ? [item] : []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const designs = [...production.previousAssets?.recipe === "b3" ? [production.previousAssets] : [], ...earlier.map(item => item.assets!)];
  const present = async (paths: string[]) => (await Promise.all(paths.map(path =>
    resolveWorkspacePath(cwd, path).then(({ path }) => access(path)).then(() => true, () => false)))).every(Boolean);
  for (const item of production.assets!.characters) {
    for (const other of designs) {
      const match = other.characters.find(person => person.name === item.name && person.photo === item.photo && (item.photo || person.look === item.look));
      if (!match?.outfits?.length) continue;
      if (item.photo) {
        const current = await readFile((await resolveWorkspacePath(cwd, item.photo)).path);
        if (!match.photoSha256 || createHash("sha256").update(current).digest("hex") !== match.photoSha256) continue;
      }
      if (!item.base && match.base && match.views && await present([match.base, ...match.views])) Object.assign(item, { base: match.base, views: match.views, photoSha256: match.photoSha256 });
      for (const outfit of item.outfits ?? []) {
        const views = match.outfits?.find(other => other.name === outfit.name && other.look === outfit.look)?.views;
        const planned = production.execution!.characters.find(person => person.name === item.name)!;
        const count = { front: 1, frontAndQuarter: 2, full: 3 }[planned.views];
        if (!outfit.views && views?.length === count && await present(views)) outfit.views = views;
      }
    }
  }
  for (const item of production.assets!.places) {
    const match = designs.flatMap(other => other.places).find(place => place.name === item.name && place.look === item.look && place.base && place.views);
    if (!item.base && match && await present([match.base!, ...match.views!])) Object.assign(item, { base: match.base, views: match.views });
  }
}

/**
 * Draws each asset's base and then its own views, notifying the pipeline as soon as that asset is ready.
 * Requests share Qwen-Image's batch queue; an unrelated unfinished base never holds up another person's views.
 */
export async function drawAssets(cwd: string, production: Production, ratio: string, signal: AbortSignal, save: () => Promise<void>, ready: (asset: ProductionAsset) => void, writePrompt: (brief: string, ratio: string) => Promise<string>) {
  const assets = production.assets!;
  if (assets.recipe !== "b3") throw new Error("Assets must be created with the B3 recipe");
  await reuseDesigns(cwd, production);
  await save();
  const release = holdQwenImage();
  try {
    const results = await Promise.allSettled([
      ...assets.characters.map(async item => {
        if (!item.base) {
          const outfit = item.outfits![0]!;
          if (item.photo) {
            item.photoSha256 = createHash("sha256").update(await readFile((await resolveWorkspacePath(cwd, item.photo)).path)).digest("hex");
            item.base = item.photo;
          }
          else {
            item.generationPrompt ??= { text: await writePrompt(JSON.stringify({ task: "Describe one full-body studio identity photograph of exactly one specified person, standing facing the camera with arms relaxed and the entire body and feet visible. This is a neutral character design, not a story action or environment plate.", identity: item.look, outfit: outfit.look, studio, requestedRatio: "2:3" }), "2:3") };
            await save();
            item.base = await draw(cwd, production.id, item.generationPrompt.text, "2:3", [], signal);
          }
          await save();
        }
        const views = await Promise.allSettled([
          !item.views ? (async () => {
            const rule = "Keep the identity and clothing in {{ref 1}} unchanged.";
            const planned = production.execution!.characters.find(person => person.name === item.name)!;
            item.views = await Promise.all(faceViews.slice(0, planned.views === "front" ? 1 : 2).map(([viewRatio, view]) => draw(cwd, production.id, `${view} ${rule} ${finish}`, viewRatio, [item.base!], signal)));
            await save();
          })() : undefined,
          ...(item.outfits ?? []).filter(outfit => {
            const planned = production.execution!.characters.find(person => person.name === item.name)!;
            return outfit.views?.length !== { front: 1, frontAndQuarter: 2, full: 3 }[planned.views];
          }).map(async outfit => {
            const rule = `Keep the identity in {{ref 1}} and change the outfit to ${outfit.look}.`;
            const planned = production.execution!.characters.find(person => person.name === item.name)!;
            const count = { front: 1, frontAndQuarter: 2, full: 3 }[planned.views];
            outfit.views = await Promise.all(outfitViews.slice(0, count).map(([viewRatio, view]) => draw(cwd, production.id, `${view} ${rule} ${finish}`, viewRatio, [item.base!], signal)));
            await save();
          }),
        ]);
        const failure = views.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
        ready(item);
      }),
      ...assets.places.map(async item => {
        const opening = production.plan!.shots.find(shot => shot.place === item.name);
        const layout = opening ? JSON.stringify(opening.actors.map(({ pose, gaze }) => ({ laterActorPose: pose, laterGaze: gaze }))) : "No additional furniture layout constraints";
        if (!item.base) {
          if (!item.generationPrompt) {
            const text = await writePrompt(JSON.stringify({ task: "Describe one empty environment photograph, before any actors enter. The environment itself is the only subject. Describe an unobstructed, vacant foreground, ground plane, midground and background; every visible region is unoccupied. Preserve the intended setting, static props, light and materials. Translate any later actor support into furniture only. Exclude people, faces, human reflections, silhouettes and actor-held props from the depicted content. Keep useful environment detail legible rather than turning the whole setting into portrait bokeh. Do not add a table, chair or product unless required by the environment or support needs. No readable text is requested.", environment: item.look, laterSupportRequirements: layout, requestedRatio: ratio }), ratio);
            item.generationPrompt = { text };
            await save();
          }
          const reference = production.references?.find(reference => reference.use === "environment" && reference.target === item.name);
          item.base = await draw(cwd, production.id, `${reference ? "Use the architecture, materials and lighting of {{ref 1}} as the environment reference. " : ""}${item.generationPrompt.text}`, ratio, reference ? [reference.path] : [], signal);
          await save();
        }
        if (!item.views) {
          const rule = "Keep the image's empty environment, furniture, static props and lighting unchanged.";
          const planned = production.execution!.places.find(place => place.name === item.name)!;
          item.views = [item.base!, ...await Promise.all((planned.views === "front" ? [] : placeViews).map(view => draw(cwd, production.id, `${view} ${rule}`, ratio, [item.base!], signal)))];
          await save();
        }
        ready(item);
      }),
    ]);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  } finally {
    release();
  }
}

// ACT: Measured per LoRA: one L4 hour of training per family and about ten A100 minutes of generated variants per
// person or place, with the same 1.3 margin as the production estimate; scaled since by the character recipe, about
// 1500 steps instead of about 1200 and up to 31 drawn variants instead of 11. Training now runs on an A100, assumed
// to take half the L4's time until a run is measured.
const unitsPerFamily = 6.77 * 1.3 * 1.25 / 2;
const unitsPerTopUp = 6.77 / 6 * 1.3 * 31 / 11;

/**
 * The LoRA each person gets, trained from this production's matching source designs: clips start from no picture of
 * them, so their LoRA is all that keeps them the same, even in a single shot. Places get none: a scene LoRA learns its
 * designs' single framing with the room and pulled every shot back to that wide, still view, so the clip prompt
 * describes the place instead. A name alone cannot prove another production's training identity. Each trigger is fixed when
 * planned and kept on the asset, so texts can name it
 * while it trains. `units` is what the training will cost.
 */
export async function planAssetLoras(cwd: string, production: Production) {
  const assets = production.assets!;
  const existing = await workspaceLoras(cwd);
  // Only the video model takes LoRAs; Qwen-Image only draws the designs they are trained from.
  const families: ("ltx" | "qwen")[] = ["ltx"];
  const jobs = assets.characters.map(item => ({ item, kind: "character" as const })).filter(job => !job.item.loras).map(({ item, kind }) => {
    item.triggers ??= Object.fromEntries(families.map(family =>
      [family, triggerWord()]));
    const kept = existing.filter(record => record.trigger === item.triggers![record.family]);
    return { item, kind, kept, missing: families.filter(family => !kept.some(record => record.family === family)) };
  });
  const units = jobs.reduce((sum, job) => sum + (job.missing.length ? job.missing.length * unitsPerFamily + unitsPerTopUp : 0), 0);
  return { jobs, units };
}

/** Trains one asset as soon as its own designs are ready. */
export async function trainAssetLora(cwd: string, { item, kind, kept, missing }: Awaited<ReturnType<typeof planAssetLoras>>["jobs"][number], signal: AbortSignal, save: () => Promise<void>) {
  const trained = missing.length ? await trainLora(cwd, { kind, families: missing, name: item.name, items: assetViews(item).map(path => ({ path })), triggers: item.triggers }, signal) : [];
  item.loras = [...kept, ...trained].map(record => ({ family: record.family, path: record.path, trigger: record.trigger }));
  await save();
}

/**
 * The workspace's LoRA records whose weights are still there, newest first: a record left after its file was deleted
 * is no LoRA, so its person is trained again rather than every clip failing on the missing file.
 */
async function workspaceLoras(cwd: string) {
  const folder = (await resolveWorkspacePath(cwd, "loras", true)).path;
  const names = (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith(".json"));
  const records = await Promise.all(names.map(async name => {
    const record = await readFile(`${folder}/${name}`, "utf8").then(text => JSON.parse(text) as LoraRecord, () => undefined);
    if (!record?.trigger || !record.path) return undefined;
    // A path outside the workspace is refused like a missing file.
    return await resolveWorkspacePath(cwd, record.path, true).then(({ path }) => access(path)).then(() => record, () => undefined);
  }));
  return records.filter((record): record is LoraRecord => !!record).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every reference image of a person or place, across outfits, as a LoRA learns them. */
export const assetViews = (item: ProductionAsset) => [...item.views ?? [], ...(item.outfits ?? []).flatMap(outfit => outfit.views ?? [])];
