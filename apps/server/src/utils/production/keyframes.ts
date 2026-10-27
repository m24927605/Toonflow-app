import { mkdir } from "@toonflow/file";
import { translate } from "@toonflow/i18n";
import { keyframeDescriptionInstructions, keyframeTemplate, stateLine } from "@toonflow/node-shared/keyframePrompt";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { generateMedia } from "@/utils/media/generation";
import { draw } from "./assets";
import { checkImages, keyframeCheckPrompt, majorProblems, readCheck, type VisualCheck } from "./checks";
import { describeGaze } from "./plan";
import { opensUpright, shotReferences } from "./shots";
import { productionDirectory, type Production, type ProductionAsset } from "./state";

const english = (line: Parameters<typeof translate>[0] | string) => typeof line === "string" ? line : translate(line, undefined, "en");

/**
 * Draws the first frame of a clothed shot that does not continue the clip before it, so the clip starts from the
 * people's and the place's designs instead of from words: Sulphur 2 takes no reference images, and clips written from text alone drew
 * a different room and drifting faces in every shot. The text model describes the opening moment from the shot-list row,
 * the contract and the previs; Qwen-Image draws it from the place's design and each person's design in their outfit.
 * When everyone stands, the previs depth fixes the composition; its upright columns would turn anyone lying, sitting or
 * kneeling into a pillar, so such shots take their composition from the description alone.
 */
// How many times a keyframe whose check fails is drawn again, each time told what went wrong; the best drawing is kept.
const keyframeCorrections = 2;

export async function drawKeyframe(cwd: string, production: Production, shotNumber: number, script: string, shotList: string, complete: (prompt: string) => Promise<string>, look: (prompt: string, images: string[]) => Promise<string>, signal: AbortSignal, save: () => Promise<void>) {
  const shot = production.shots!.find(item => item.shot === shotNumber)!;
  if (shot.startFrame) return;
  if (explicitShot(production, shotNumber)) return drawExplicitKeyframe(cwd, production, shotNumber, script, shotList, complete, look, signal, save);
  const previs = production.previs!.find(item => item.shot === shotNumber)!;
  const contract = production.plan!.shots.find(item => item.shot === shotNumber)!;
  const { people, place } = shotReferences(shot, production.assets!, previs.framed);
  const inFrame = people.map(({ person }) => person).filter(person => previs.framed.opening.includes(person.name));
  const poses = contract.actors.filter(actor => previs.framed.opening.includes(actor.name))
    .map(actor => `${actor.name}: ${actor.pose} ${describeGaze(actor.gaze)}.${actor.props.length ? ` Holding: ${actor.props.join(", ")}.` : ""}`);
  const description = parseDescription(await complete([
    ...keyframeDescriptionInstructions(shotNumber, shot.time, previs.framed.opening, shot.state, previs.blocking).map(english),
    ...poses.length ? [`Opening poses from the production contract, which win over the previs where they differ: ${poses.join(" ")}`] : [],
    "", "Screenplay:", script, "", "Shot list:", shotList,
  ].join("\n")), shotNumber);
  const folder = `${productionDirectory(production.id)}/keyframes`;
  await mkdir((await resolveWorkspacePath(cwd, folder, true)).path, { recursive: true });
  const depth = opensUpright(production, shotNumber) && previs.depthVideo ? await firstFrame(cwd, previs.depthVideo, `${folder}/shot${shotNumber}Depth.png`, signal) : undefined;
  // A person's reference is the front view of the outfit they wear in this shot, so the keyframe draws those clothes.
  const outfitView = (person: ProductionAsset) => person.outfits?.find(outfit => outfit.name === shot.outfits[person.name])?.views?.[0] ?? person.base!;
  const offset = depth ? 1 : 0;
  const references = [...depth ? [depth] : [], place.place.base!, ...inFrame.map(outfitView)];
  const prompt = [
    ...depth ? ["{{ref 1}} fixes the composition: the camera, the framing and where each person stands."] : [],
    ...keyframeTemplate([offset + 1], inFrame.map((person, index) => ({ name: person.name, ref: offset + 2 + index }))).map(english),
    ...shot.state ? [english(stateLine(shot.state))] : [],
    "A photorealistic live-action film still.",
  ].join(" ").replace("{{shot}}", description);
  // Each drawing is checked by the vision model against the designs, the row and the poses; one that fails is drawn
  // again with its problems named, and the drawing with the fewest major problems is kept.
  const looks = references.slice(depth ? 1 : 0);
  const drawings: { image: string; prompt: string; check: VisualCheck }[] = [];
  for (let attempt = 0; attempt <= keyframeCorrections; attempt++) {
    const problems = drawings.at(-1) ? majorProblems(drawings.at(-1)!.check) : [];
    const asked = problems.length ? `${prompt} Avoid what went wrong in an earlier drawing: ${problems.join("; ")}.` : prompt;
    const image = await draw(cwd, production.id, asked, production.input.ratio, references, signal, depth ? "qwen_image_2_1_depth" : undefined, "1K", "keyframes");
    const images = await checkImages(cwd, production, `shot${shotNumber}Keyframe${attempt + 1}`, looks, { image }, signal);
    let check = readCheck(await look(keyframeCheckPrompt(shot.row ?? "", poses.join(" "), looks.length), images));
    if (check.unreadable) check = readCheck(await look(keyframeCheckPrompt(shot.row ?? "", poses.join(" "), looks.length), images));
    drawings.push({ image, prompt: asked, check });
    if (check.passed) break;
  }
  const kept = drawings.reduce((best, item) => majorProblems(item.check).length < majorProblems(best.check).length ? item : best);
  if (!kept.check.passed) console.warn(`[production] Shot ${shotNumber}: keyframe kept with problems`, majorProblems(kept.check));
  shot.startFrame = kept.image;
  shot.keyframe = { description, prompt: kept.prompt, check: kept.check };
  await save();
}

/**
 * Draws the first frame of an explicit shot with LUSTIFY v10 (Krea 2), which draws sex acts and genitals correctly where
 * Qwen-Image drew them wrong: LUSTIFY takes no reference images, so the prompt carries the place and every look in
 * words, and each person's Krea 2 LoRA locks their face, applied to the heads from left to right as the text model
 * orders the people. The prompt follows Krea 2's own order, as Krea's Krea-2-Turbo system prompt gives it: subject and
 * action, appearance, composition, environment, lighting, and the medium last; written the other way round, with the
 * medium and the room first, LUSTIFY drew oversized penises and kept a gap at the groin in every seed of 〈雨夜〉
 * (2026-10-27). The same vision check as for other keyframes picks the best of up to three drawings, judged on the
 * face-locked drawing, since the lock redraws the bodies as well.
 */
async function drawExplicitKeyframe(cwd: string, production: Production, shotNumber: number, script: string, shotList: string, complete: (prompt: string) => Promise<string>, look: (prompt: string, images: string[]) => Promise<string>, signal: AbortSignal, save: () => Promise<void>) {
  const shot = production.shots!.find(item => item.shot === shotNumber)!;
  const previs = production.previs!.find(item => item.shot === shotNumber)!;
  const contract = production.plan!.shots.find(item => item.shot === shotNumber)!;
  const { people, place } = shotReferences(shot, production.assets!, previs.framed);
  const inFrame = people.map(({ person }) => person).filter(person => previs.framed.opening.includes(person.name));
  const poses = contract.actors.filter(actor => previs.framed.opening.includes(actor.name))
    .map(actor => `${actor.name}: ${actor.pose} ${describeGaze(actor.gaze)}.`);
  const reply = await complete([
    `Describe the opening still frame of shot ${shotNumber} (${shot.time}) of the attached shot list, an explicit adult shot for an uncensored image model, from that row's description and action columns, as exactly these lines:`,
    `"Act: " then one paragraph of 40 to 120 words. Its first sentence names ${inFrame.map(person => person.name).join(" and ") || "the people"} and the sex act at its deepest point in crude everyday words: in intercourse his average-sized penis is buried completely inside her to the root, his groin pressed flat against her crotch with no gap and none of the shaft showing; in oral sex his average-sized erect penis is mostly inside her mouth. Then each person's posture, where each of their hands is and what it holds or grips, and where they look; the two look at each other unless the row says otherwise. Genitals are always average-sized.`,
    `"Frame: " then one sentence: the shot size, the camera position, height and angle from the shot list, framed so every face in the shot is fully in the picture.`,
    `"Light: " then one sentence: the light source and its colour at this time of day, from the screenplay.`,
    `"Left to right: " then the names of the people in frame in the order they appear from the left edge of the picture.`,
    "Do not write anyone's face, hair, body type or clothes, the room, style words or reference markers.",
    ...previs.blocking ? [`The previs fixes the opening frame: ${previs.blocking}. Place each person and the camera to match it.`] : [],
    ...poses.length ? [`Opening poses from the production contract, which win over the previs where they differ: ${poses.join(" ")}`] : [],
    ...shot.state ? [`At the start of this shot the character state is: ${shot.state}.`] : [],
    "", "Screenplay:", script, "", "Shot list:", shotList,
  ].join("\n"));
  const line = (label: string) => new RegExp(`^\\s*${label}:\\s*(.+)$`, "im").exec(reply)?.[1]?.trim().replace(/\s+/g, " ");
  const [act, frame, light] = [line("Act"), line("Frame"), line("Light")];
  if (!act || !frame || !light) throw new Error(`Shot ${shotNumber}: the explicit keyframe description lacks its Act, Frame or Light line`);
  const order = line("Left to right")?.split(/[,，、]/).map(name => name.trim().replace(/\.$/, "")).filter(Boolean) ?? [];
  const ordered = [...order.flatMap(name => inFrame.filter(person => person.name === name)), ...inFrame.filter(person => !order.includes(person.name))];
  const triggerOf = (person: ProductionAsset) => person.loras?.find(lora => lora.family === "krea2")?.trigger;
  const outfitOf = (person: ProductionAsset) => person.outfits?.find(outfit => outfit.name === shot.outfits[person.name]);
  const named = (text: string) => ordered.reduce((result, person) => triggerOf(person) ? result.replaceAll(person.name, triggerOf(person)!) : result, text);
  const looks = ordered.map(person => `${triggerOf(person) ?? person.name} is ${person.look.replace(/\.$/, "")}${outfitOf(person) ? `, ${outfitOf(person)!.nude ? "naked" : `wearing ${outfitOf(person)!.look.replace(/\.$/, "")}`}` : ""}.`);
  const description = named(`${act} ${frame}`);
  const prompt = [named(act), ...looks, ...shot.state ? [english(stateLine(shot.state))] : [], named(frame), ...place.place.look ? [place.place.look] : [], light,
    "Photorealistic photograph, natural skin texture, realistic proportions."].join(" ");
  const loras = ordered.flatMap(person => person.loras?.filter(lora => lora.family === "krea2") ?? []).map(lora => ({ path: lora.path }));
  const references = [place.place.base!, ...inFrame.map(person => outfitOf(person)?.views?.[0] ?? person.base!)];
  const folder = `${productionDirectory(production.id)}/keyframes`;
  const drawings: { image: string; prompt: string; check: VisualCheck }[] = [];
  for (let attempt = 0; attempt <= keyframeCorrections; attempt++) {
    const problems = drawings.at(-1) ? majorProblems(drawings.at(-1)!.check) : [];
    const asked = problems.length ? `${prompt} Avoid what went wrong in an earlier drawing: ${problems.join("; ")}.` : prompt;
    const [drawn] = await generateMedia(cwd, "image", { providerId: "lustify", modelId: "lustify_v10_krea2", prompt: asked, ratio: production.input.ratio, size: "1K", loras, outputDirectory: folder }, signal);
    const images = await checkImages(cwd, production, `shot${shotNumber}Keyframe${attempt + 1}`, references, { image: drawn!.path }, signal);
    let check = readCheck(await look(keyframeCheckPrompt(shot.row ?? "", poses.join(" "), references.length, explicitDemands), images));
    if (check.unreadable) check = readCheck(await look(keyframeCheckPrompt(shot.row ?? "", poses.join(" "), references.length, explicitDemands), images));
    drawings.push({ image: drawn!.path, prompt: asked, check });
    if (check.passed) break;
  }
  const kept = drawings.reduce((best, item) => majorProblems(item.check).length < majorProblems(best.check).length ? item : best);
  if (!kept.check.passed) console.warn(`[production] Shot ${shotNumber}: explicit keyframe kept with problems`, majorProblems(kept.check));
  shot.startFrame = kept.image;
  shot.keyframe = { description, prompt: kept.prompt, check: kept.check };
  await save();
}

// What the user rejected in the explicit frames of 〈雨夜〉: oversized penises, a gap at the groin, faces out of frame.
const explicitDemands = "Also judge the sex act: every penis is average-sized, in intercourse it is inserted to the root with no gap between the groins, and every face in the shot is fully in the picture.";

/** Whether a shot is explicit: someone in it wears a nude outfit, or the execution plan's per-shot decision says so. */
export function explicitShot(production: Production, shotNumber: number) {
  return nudeShot(production, shotNumber) || !!production.execution?.shots?.find(item => item.shot === shotNumber)?.explicit;
}

/** Whether anyone the shot shows wears a nude outfit in it. */
export function nudeShot(production: Production, shotNumber: number) {
  const shot = production.shots!.find(item => item.shot === shotNumber)!;
  const previs = production.previs!.find(item => item.shot === shotNumber)!;
  return [...previs.framed.opening, ...previs.framed.shown].some(name => production.assets!.characters.find(person => person.name === name)?.outfits?.find(outfit => outfit.name === shot.outfits[name])?.nude);
}

/** The paragraph under the shot's "### Shot N" heading, or the whole reply when the heading is missing. */
function parseDescription(reply: string, shot: number) {
  const text = reply.replace(new RegExp(`^\\s*#{2,4}\\s*Shot\\s*${shot}\\s*\\n`, "i"), "").trim();
  if (!text || /^#{2,4}\s/m.test(text)) throw new Error(`Shot ${shot}: the keyframe description is not one paragraph`);
  return text.replace(/\s+/g, " ");
}

async function firstFrame(cwd: string, video: string, target: string, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const [source, output] = await Promise.all([resolveWorkspacePath(cwd, video), resolveWorkspacePath(cwd, target, true)]);
  await new Promise<void>((resolve, reject) => ffmpeg(source.path).frames(1).output(output.path).on("end", () => resolve()).on("error", reject).run());
  return target;
}
