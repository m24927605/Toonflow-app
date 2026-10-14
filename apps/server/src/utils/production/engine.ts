import { translate } from "@toonflow/i18n";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotListFixPrompt, shotListInstructions } from "@toonflow/node-shared/shotListPrompt";
import { getConfiguredModel, listAiModels, streamAi } from "@/utils/ai";
import { readColabBalance } from "@/utils/media/colab";
import { assetDrawn, castPrompt, drawAssets, parseCast, planAssetLoras, trainAssetLoras } from "./assets";
import { planDub, recordDub } from "./dub";
import { renderPrevis } from "./previs";
import { joinRoughCut, renderClips, writeClipPrompts } from "./video";
import { estimateProduction } from "./estimate";
import { composeKeyframe, descriptionsPrompt, drawKeyframe, parseDescriptions, planKeyframes } from "./keyframes";
import {
  productionDirectory, readProduction, readProductionText, readRegistry, saveProduction, setRegistered, writeProductionText,
  type Production, type ProductionGate, type ProductionInput,
} from "./state";

// Every text of a production is written by the uncensored Colab model "Generate shot list" uses, so no scene of a
// story is refused; it stays loaded on one L4 between requests.
const textModelId = "HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive";

const runners = new Map<string, { controller: AbortController; finished: Promise<void> }>();
const runnerKey = (cwd: string, id: string) => JSON.stringify([cwd, id]);

function textModel() {
  const model = listAiModels().find(item => item.modelId === textModelId);
  if (!model) throw new Error(`Add the Colab CLI provider with ${textModelId} in Settings first`);
  return model;
}

async function complete(systemPrompt: string, prompt: string, signal: AbortSignal) {
  const model = textModel();
  const stream = await streamAi(getConfiguredModel(model.providerId, model.modelId), { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, signal);
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "Model request failed");
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
}

const screenwriter = "You write screenplays for short films made with AI image and video models.";

// Characters only one of the two Chinese scripts uses; this model drifts to English or Simplified Chinese unless the
// language is named outright. ACT: A small character sample; it misjudges outlines that avoid all of them.
const traditionalOnly = /[們個這來說對時會裡後麼還與為無從當發點過樣實]/;
const simplifiedOnly = /[们个这来说对时会里后么还与为无从当发点过样实]/;

/** The language the outline is written in, named the way the model needs it. */
function languageOf(outline: string) {
  if (/[\u3040-\u30ff]/.test(outline)) return "Japanese";
  if (/[\u4e00-\u9fff]/.test(outline)) return simplifiedOnly.test(outline) && !traditionalOnly.test(outline) ? "Simplified Chinese" : "Traditional Chinese";
  return "the language of the outline";
}

function scriptPrompt(input: ProductionInput) {
  const named = input.photos.map(photo => photo.name);
  const language = languageOf(input.outline);
  return [
    `Write in ${language} only.`,
    `Write the complete screenplay of a short film of ${input.seconds} seconds from the outline below.`,
    "Keep the outline's people, places and events, and add only what the story needs to play out. Call every person and place exactly by the name the outline uses; never rename or translate a name or add a reading or translation after it.",
    `The film lasts ${input.seconds} seconds: every line is spoken aloud, so all dialogue together must take at most half of that time.`,
    `Start with a section listing the characters: each person's fixed name, their look (age, build, face, hair) and every outfit they wear in the story, each with a short name such as "home clothes" and a description; then a section listing the places, each with a fixed name and its look; then the scenes: a heading, the action in present tense naming the outfit when someone changes, and dialogue as "Name: line". Title the sections in ${language}.`,
    ...named.length ? [`These characters have photos, so use exactly these names for them: ${named.join(", ")}.`] : [],
    `Write everything (section titles, scene headings, action and dialogue) in ${language}; never switch to English or to another script. Output only the screenplay.`,
    "",
    "Outline:",
    input.outline,
  ].join("\n");
}

function revisionPrompt(script: string, notes: string, outline: string) {
  const language = languageOf(outline);
  return [
    `Write in ${language} only.`,
    `Rewrite the screenplay below to carry out the requested changes; they override anything in the screenplay. Keep what they do not touch, and write all of it in ${language}.`,
    "",
    "Requested changes:",
    notes,
    "",
    "Screenplay:",
    script,
  ].join("\n");
}

const shotListWriter = "You plan shots for short films made with AI image and video models.";
const english = (messages: Parameters<typeof translate>[0][]) => messages.map(item => translate(item, undefined, "en"));

/** The shot list prompt with the script inline; the characters with photos keep their names. */
function shotListPrompt(script: string, names: string[], input: ProductionInput) {
  const language = languageOf(input.outline);
  return [
    `Write in ${language} only.`,
    ...english(shotListInstructions("The script below", names)),
    `The film lasts ${input.seconds} seconds: the time ranges must end at ${input.seconds} s. Write every cell in ${language}.`,
    "In State, name each person's outfit by the short name the script's character section gives it.",
    "",
    "Script:",
    script,
  ].join("\n");
}

/** Stops for a person: a review, the budget, or anything else they must decide; `message` is a code the page words. */
async function wait(cwd: string, production: Production, message: string, review?: Production["review"], detail?: string) {
  Object.assign(production, { status: "waiting", message, review, detail });
  await saveProduction(cwd, production);
  return false;
}

/**
 * Stops before a step that would take the production past its budget. The spend is the drop of the account balance
 * since the start, so other Colab jobs running meanwhile count too; it never spends on a guess when the balance cannot
 * be read.
 */
async function withinBudget(cwd: string, production: Production, nextUnits: number, signal: AbortSignal) {
  const balance = await readColabBalance(signal).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  if (balance instanceof Error) return wait(cwd, production, "balanceUnreadable", undefined, balance.message);
  production.balanceAtStart ??= balance;
  if (production.balanceAtStart - balance + nextUnits > production.input.budget) return wait(cwd, production, "budget");
  return true;
}

/** Runs the next step and returns whether there is more to do now. */
async function step(cwd: string, id: string, signal: AbortSignal): Promise<boolean> {
  const production = await readProduction(cwd, id);
  if (production.status !== "running") return false;
  const estimate = estimateProduction(production.input);
  const needs = (gate: ProductionGate) => production.input.gates.includes(gate) && !production.approved.includes(gate);

  if (!production.script) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const path = `${productionDirectory(id)}/script.md`;
    await writeProductionText(cwd, path, `${await complete(screenwriter, scriptPrompt(production.input), signal)}\n`);
    production.script = { path };
    await saveProduction(cwd, production);
    return true;
  }
  if (production.review?.gate === "script" && production.review.notes) {
    const script = await readProductionText(cwd, production.script);
    await writeProductionText(cwd, production.script.path, `${await complete(screenwriter, revisionPrompt(script, production.review.notes, production.input.outline), signal)}\n`);
    production.script.manual = false;
    production.review = undefined;
    await saveProduction(cwd, production);
    return true;
  }
  if (needs("script")) return wait(cwd, production, "reviewScript", { gate: "script" });

  if (!production.shotList) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const names = production.input.photos.map(photo => photo.name);
    const prompt = shotListPrompt(await readProductionText(cwd, production.script), names, production.input);
    let shotList = await complete(shotListWriter, prompt, signal);
    // As "Generate shot list" does, a list failing the timing check (here also against the film's length) is
    // rewritten once with the problems found.
    const problems = checkScript(shotList, production.input.seconds).issues;
    if (problems.length) shotList = await complete(shotListWriter, shotListFixPrompt(prompt, shotList, english(problems)), signal);
    const check = checkScript(shotList, production.input.seconds);
    const path = `${productionDirectory(id)}/shotList.md`;
    await writeProductionText(cwd, path, `${shotList}\n`);
    production.shotList = { path, shots: check.shots.length, issues: check.issues };
    await saveProduction(cwd, production);
    return true;
  }

  if (!production.assets) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    production.assets = parseCast(await complete(shotListWriter, castPrompt(await readProductionText(cwd, production.script)), signal), production.input.photos);
    await saveProduction(cwd, production);
    return true;
  }
  if ([...production.assets.characters, ...production.assets.places].some(item => !assetDrawn(item))) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "assets")!.units, signal)) return false;
    await drawAssets(cwd, production, production.input.ratio, signal, () => saveProduction(cwd, production));
    return true;
  }

  if ([...production.assets.characters, ...production.assets.places].some(item => !item.loras)) {
    // Only the LoRAs actually trained count against the budget; reused and skipped ones cost nothing.
    const plan = await planAssetLoras(cwd, production, await readProductionText(cwd, production.shotList));
    if (plan.units && !await withinBudget(cwd, production, plan.units, signal)) return false;
    await trainAssetLoras(cwd, plan, signal, () => saveProduction(cwd, production));
    return true;
  }

  if (!production.keyframes) {
    production.keyframes = planKeyframes(await readProductionText(cwd, production.shotList), production.assets);
    await saveProduction(cwd, production);
    return true;
  }
  const keyframes = production.keyframes;
  if (keyframes.shots.some(item => item.description === undefined)) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const [script, shotList] = await Promise.all([readProductionText(cwd, production.script), readProductionText(cwd, production.shotList)]);
    const sections = parseDescriptions(await complete(shotListWriter, descriptionsPrompt(script, shotList, keyframes.shots), signal));
    for (const item of keyframes.shots) item.description = sections.get(item.shot) ?? item.row ?? "";
    await saveProduction(cwd, production);
    return true;
  }
  // The master shot is drawn first; every other keyframe then takes it as the reference for light, colour and clothing,
  // and they are drawn together so Qwen-Image draws them in one Colab session.
  const master = keyframes.shots.find(item => item.shot === keyframes.master) ?? keyframes.shots[0]!;
  const pending = master.image ? keyframes.shots.filter(item => !item.image) : [master];
  if (pending.length) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "keyframes")!.units, signal)) return false;
    await Promise.all(pending.map(async item => {
      Object.assign(item, composeKeyframe(item, production.assets!, item === master ? undefined : master.image));
      item.image = await drawKeyframe(cwd, production, item, signal);
      await saveProduction(cwd, production);
    }));
    return true;
  }
  if (needs("keyframes")) return wait(cwd, production, "reviewKeyframes", { gate: "keyframes" });

  // Dubbing comes before video: H3 lip-syncs to each shot's track, and a shot is as long as its lines need. Gemini TTS
  // bills its own API, not Colab units.
  if (!production.dub) {
    production.dub = planDub(await readProductionText(cwd, production.shotList), production.assets);
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.clips) {
    production.clips = await recordDub(cwd, production, signal, () => saveProduction(cwd, production));
    await saveProduction(cwd, production);
    return true;
  }

  // Every video needs its shot's previs: the director agent blocks the shots with cylinders in a headless Chrome.
  if (!production.previs) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const [script, shotList] = await Promise.all([readProductionText(cwd, production.script), readProductionText(cwd, production.shotList)]);
    const model = textModel();
    production.previs = await renderPrevis(cwd, production, script, shotList, { providerId: model.providerId, modelId: model.modelId }, signal);
    await saveProduction(cwd, production);
    return true;
  }

  const videoWriter = "You write prompts for the MiniMax H3 video model.";
  if (!production.videos) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const [script, shotList] = await Promise.all([readProductionText(cwd, production.script), readProductionText(cwd, production.shotList)]);
    production.videos = await writeClipPrompts(production, script, shotList, prompt => complete(videoWriter, prompt, signal));
    await saveProduction(cwd, production);
    return true;
  }
  // The rough cut is always 480p: cheap to watch through; the chosen final quality is rendered only for approved shots.
  if (production.videos.some(item => !item.video)) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "roughCut")!.units, signal)) return false;
    await renderClips(cwd, production, "480p", signal, () => saveProduction(cwd, production));
    return true;
  }
  if (!production.roughCut) {
    production.roughCut = await joinRoughCut(cwd, production, signal);
    await saveProduction(cwd, production);
    return true;
  }

  // ACT: The production currently ends with the 480p rough cut; the final quality, music and subtitles follow in phase 3.
  Object.assign(production, { status: "done", message: "roughCutDone", review: undefined });
  await saveProduction(cwd, production);
  return false;
}

/** Runs a production in the background until it waits, fails or finishes; a second call while it runs does nothing. */
export function runProduction(cwd: string, id: string) {
  const key = runnerKey(cwd, id);
  if (runners.has(key)) return;
  const controller = new AbortController();
  const finished = (async () => {
    await setRegistered(cwd, id, true);
    try {
      while (await step(cwd, id, controller.signal));
    } catch (error) {
      if (!controller.signal.aborted) {
        const production = await readProduction(cwd, id);
        Object.assign(production, { status: "failed", message: error instanceof Error ? error.message : String(error) });
        await saveProduction(cwd, production);
      }
    } finally {
      runners.delete(key);
      await setRegistered(cwd, id, false).catch(() => {});
    }
  })().catch(error => console.error("[production] Runner failed:", error));
  runners.set(key, { controller, finished });
}

export async function createProduction(cwd: string, id: string, input: ProductionInput) {
  const now = new Date().toISOString();
  await saveProduction(cwd, {
    toonflowProduction: 1, id, createdAt: now, updatedAt: now, input, status: "running", approved: [],
    estimate: estimateProduction(input).total,
  });
  runProduction(cwd, id);
}

/**
 * Answers the review a production waits on: approves it, or sends change requests that the engine carries out before
 * asking again. A script a person edited in place is saved first and kept as written.
 */
export async function reviewProduction(cwd: string, id: string, answer: { notes?: string; script?: string }) {
  const production = await readProduction(cwd, id);
  if (production.status !== "waiting" || !production.review) throw Object.assign(new Error("This production is not waiting for a review"), { status: 409 });
  if (answer.script !== undefined && production.script) {
    await writeProductionText(cwd, production.script.path, answer.script);
    production.script.manual = true;
  }
  const gate = production.review.gate;
  if (answer.notes) production.review = { gate, notes: answer.notes };
  else {
    production.approved.push(gate);
    production.review = undefined;
  }
  Object.assign(production, { status: "running", message: undefined, detail: undefined });
  await saveProduction(cwd, production);
  runProduction(cwd, id);
}

/** Continues a production stopped by its budget or an error, with a new budget when given. */
export async function resumeProduction(cwd: string, id: string, budget?: number) {
  const production = await readProduction(cwd, id);
  if (production.status === "done" || production.review) throw Object.assign(new Error("This production has nothing to continue"), { status: 409 });
  if (budget !== undefined) production.input.budget = budget;
  Object.assign(production, { status: "running", message: undefined, detail: undefined });
  await saveProduction(cwd, production);
  runProduction(cwd, id);
}

/** Stops a running production after aborting its current step; paid work already running on Colab is stopped too. */
export async function stopProduction(cwd: string, id: string) {
  const runner = runners.get(runnerKey(cwd, id));
  runner?.controller.abort();
  await runner?.finished;
  const production = await readProduction(cwd, id);
  if (production.status !== "running") return;
  Object.assign(production, { status: "waiting", message: "stopped" });
  await saveProduction(cwd, production);
}

/** Restarts the productions that were running when the server stopped. */
export async function resumeRunningProductions() {
  for (const { cwd, id } of await readRegistry()) {
    const production = await readProduction(cwd, id).catch(() => undefined);
    if (production?.status === "running") runProduction(cwd, id);
    else await setRegistered(cwd, id, false);
  }
}

export const isProductionRunning = (cwd: string, id: string) => runners.has(runnerKey(cwd, id));
