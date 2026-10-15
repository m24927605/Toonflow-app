import { t, translate } from "@toonflow/i18n";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotListFixPrompt, shotListInstructions } from "@toonflow/node-shared/shotListPrompt";
import { getConfiguredModel, holdColab, listAiModels, streamAi } from "@/utils/ai";
import { readColabBalance } from "@/utils/media/colab";
import { holdQwenImage } from "@/utils/media/qwenImage";
import { assetDrawn, castPrompt, drawAssets, parseCast, peopleWithLoras, planAssetLoras, trainAssetLoras } from "./assets";
import { planDub, recordDub } from "./dub";
import { renderPrevis } from "./previs";
import { clipCheckPrompt, clipFrames, finishFilm, joinRoughCut, readClipCheck, renderClips, scoreFilm, writeClipPrompts } from "./video";
import { costRatio, estimateProduction, recordProductionCost } from "./estimate";
import { composeKeyframe, descriptionsPrompt, drawKeyframe, keyframeRevisionPrompt, parseDescriptions, planKeyframes } from "./keyframes";
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

/** Asks the text model, which also reads `images` after the prompt (PNG bytes as base64). */
async function complete(systemPrompt: string, prompt: string, signal: AbortSignal, images: string[] = []) {
  const model = textModel();
  const content = images.length ? [{ type: "text" as const, text: prompt }, ...images.map(data => ({ type: "image" as const, data, mimeType: "image/png" }))] : prompt;
  const stream = await streamAi(getConfiguredModel(model.providerId, model.modelId), { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] }, signal);
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
  const estimate = estimateProduction(production.input, 0, await costRatio());
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
  // Designs and their LoRAs need the cast while previs needs only the shot list, so the two run side by side on
  // separate machines, the budget checked once for both; the keyframes start when both are done. Only the LoRAs
  // actually trained count against the budget; reused and skipped ones cost nothing.
  const everyAsset = [...production.assets.characters, ...production.assets.places];
  const drawn = everyAsset.every(assetDrawn);
  const trained = everyAsset.every(item => item.loras);
  if (!drawn || !trained || !production.previs) {
    const plan = trained ? undefined : await planAssetLoras(cwd, production, await readProductionText(cwd, production.shotList));
    const units = (drawn ? 0 : estimate.steps.find(item => item.step === "assets")!.units) + (plan?.units ?? 0)
      + (production.previs ? 0 : estimate.steps.find(item => item.step === "text")!.units);
    if (units && !await withinBudget(cwd, production, units, signal)) return false;
    const save = () => saveProduction(cwd, production);
    const results = await Promise.allSettled([
      (async () => {
        if (!drawn) await drawAssets(cwd, production, production.input.ratio, signal, save);
        if (plan) await trainAssetLoras(cwd, plan, signal, save);
      })(),
      // Every shot is blocked in previs before its keyframe, as Code Video Model renders its proxy before the
      // reference image: the director agent blocks the shots with cylinders in a headless Chrome, and each keyframe
      // keeps its shot's previs composition, so the first frame and the previs a clip is given never disagree.
      (async () => {
        if (production.previs) return;
        const [script, shotList] = await Promise.all([readProductionText(cwd, production.script!), readProductionText(cwd, production.shotList!)]);
        const model = textModel();
        // The page gives each director turn 10 minutes, which a cold Colab start can take by itself, and a shot's
        // render can outlast the session's idle stop: the model is loaded here first and held until previs ends.
        const release = holdColab();
        try {
          await complete("Reply with OK.", "OK?", signal);
          production.previs = await renderPrevis(cwd, production, script, shotList, { providerId: model.providerId, modelId: model.modelId }, signal);
        } finally {
          release();
        }
        await save();
      })(),
    ]);
    // Both are awaited before an error is passed on, so nothing keeps running unwatched.
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
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
    const sections = parseDescriptions(await complete(shotListWriter, descriptionsPrompt(script, shotList, keyframes.shots, production.previs), signal));
    for (const item of keyframes.shots) item.description = sections.get(item.shot) ?? item.row ?? "";
    await saveProduction(cwd, production);
    return true;
  }
  // A reviewer's change requests rewrite the descriptions of the shots they concern; those shots are drawn again with
  // their own seeds, so only what was asked changes, and the review comes round again.
  if (production.review?.gate === "keyframes" && production.review.notes) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const sections = parseDescriptions(await complete(shotListWriter, keyframeRevisionPrompt(keyframes.shots, production.review.notes), signal));
    for (const item of keyframes.shots) {
      const description = sections.get(item.shot);
      if (description === undefined) continue;
      item.description = description;
      delete item.image;
    }
    production.review = undefined;
    await saveProduction(cwd, production);
    return true;
  }
  // The master shot is drawn first; every other keyframe then takes it as the reference for light, colour and clothing,
  // and they are drawn together so Qwen-Image draws them in one batch. The session is held between the two batches, so
  // both run on one machine.
  const master = keyframes.shots.find(item => item.shot === keyframes.master) ?? keyframes.shots[0]!;
  if (keyframes.shots.some(item => !item.image)) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "keyframes")!.units, signal)) return false;
    const release = holdQwenImage();
    try {
      for (const batch of [[master], keyframes.shots.filter(item => item !== master)]) {
        await Promise.all(batch.filter(item => !item.image).map(async item => {
          Object.assign(item, composeKeyframe(item, production.assets!, production.previs!.find(shot => shot.shot === item.shot)!.depth, item === master ? undefined : master.image));
          Object.assign(item, await drawKeyframe(cwd, production, item, signal));
          await saveProduction(cwd, production);
        }));
      }
    } finally {
      release();
    }
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
    await renderClips(cwd, production, production.videos, "480p", "clips", signal, () => saveProduction(cwd, production));
    return true;
  }
  // Each clip is checked against its keyframe by the model reading frames of it: a clip that fails is rendered once more
  // with a new seed, and one that fails again stays, flagged for a person to look at.
  const unchecked = production.videos.filter(item => !item.check);
  if (unchecked.length) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    for (const item of unchecked) {
      const keyframe = production.keyframes.shots.find(shot => shot.shot === item.shot)!;
      const frames = await clipFrames(cwd, production, item, keyframe.image!, signal);
      item.check = readClipCheck(await complete(checker, clipCheckPrompt(keyframe.description ?? "", item.prompt ?? ""), signal, frames));
      if (!item.check.passed && !item.retried) Object.assign(item, { retried: true, video: undefined, seed: undefined, check: undefined });
      await saveProduction(cwd, production);
    }
    return true;
  }
  if (!production.roughCut) {
    production.roughCut = await joinRoughCut(cwd, production, signal);
    await saveProduction(cwd, production);
    return true;
  }

  // The film: the clips render again at the chosen quality with the rough cut's prompts and seeds, so the shots keep
  // what the rough cut showed; a 480p film uses the rough cut's clips.
  if (production.input.quality !== "480p" && !production.finals) {
    production.finals = production.videos.map(({ shot, prompt, seed }) => ({ shot, prompt, seed }));
    await saveProduction(cwd, production);
    return true;
  }
  if (production.finals?.some(item => !item.video)) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "final")!.units, signal)) return false;
    await renderClips(cwd, production, production.finals, production.input.quality, "final", signal, () => saveProduction(cwd, production));
    return true;
  }
  if (production.input.music && !production.music) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const seconds = production.clips.reduce((sum, item) => sum + item.clip, 0);
    const style = await complete(composer, musicPrompt(await readProductionText(cwd, production.script), seconds), signal);
    production.music = await scoreFilm(cwd, production, style, seconds, signal);
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.film) {
    production.film = await finishFilm(cwd, production, signal);
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.report) {
    production.report = await deliveryReport(cwd, production, signal);
    await saveProduction(cwd, production);
    return true;
  }
  Object.assign(production, { status: "done", message: "filmDone", review: undefined });
  await saveProduction(cwd, production);
  return false;
}

const composer = "You describe film scores for a music generation model.";
const checker = "You check AI-generated video clips for a film editor.";

/** Asks for the Suno style prompt of an instrumental score that follows the story under its dialogue. */
function musicPrompt(script: string, seconds: number) {
  return [
    `Describe the instrumental score of the short film below as a style prompt for a music model, in English: genre, instruments, tempo, and how the mood moves over its ${seconds} seconds with the story. It plays under the dialogue, so keep it sparse and soft.`,
    "No vocals, no lyrics, no names of artists or songs. At most 600 characters. Output only the description.",
    "",
    "Screenplay:",
    script,
  ].join("\n");
}

/** The delivery report in the interface language: the film, what it cost, each shot's files and seeds, the LoRAs and models used. */
async function deliveryReport(cwd: string, production: Production, signal: AbortSignal) {
  const balance = await readColabBalance(signal).catch(() => undefined);
  const spent = balance !== undefined && production.balanceAtStart !== undefined ? (production.balanceAtStart - balance).toFixed(2) : "?";
  if (spent !== "?") await recordProductionCost(production.estimate, Number(spent));
  const clips = production.finals ?? production.videos!;
  const loras = [...production.assets!.characters, ...production.assets!.places].flatMap(asset => (asset.loras ?? []).map(lora => `| ${asset.name} | ${lora.family} | ${lora.trigger} | ${lora.path} |`));
  const lines = [
    `# ${t`Production report`}`,
    "",
    t`Film: ${production.film}, ${production.input.quality}, ${clips.length} shots.`,
    t`Colab compute units: ${spent} spent of a ${production.input.budget} budget (estimate ${production.estimate}); the balance shows spending a few minutes late.`,
    t`Dialogue: Gemini TTS, billed by the Google account.`,
    ...production.music ? [t`Music: Suno V6, billed by the sunoapi.org account.`] : [],
    "",
    `## ${t`Shots`}`,
    "",
    `| ${t`Shot`} | ${t`Keyframe`} | ${t`Clip`} | ${t`Keyframe seed`} | ${t`Clip seed`} |`,
    "| --- | --- | --- | --- | --- |",
    ...production.keyframes!.shots.map(item => {
      const clip = clips.find(other => other.shot === item.shot);
      return `| ${item.shot} | ${item.image ?? ""} | ${clip?.video ?? ""} | ${item.seed ?? ""} | ${clip?.seed ?? ""} |`;
    }),
    "",
    `## ${t`LoRAs`}`,
    "",
    ...loras.length ? [`| ${t`Name`} | ${t`Model`} | ${t`Trigger word`} | ${t`File`} |`, "| --- | --- | --- | --- |", ...loras] : [t`None.`],
    "",
    `## ${t`Models`}`,
    "",
    `- ${t`Script, shot list, descriptions and prompts: ${textModel().modelId} on Colab`}`,
    `- ${t`Keyframes and designs: Qwen-Image 2.1 Turbo on Colab, keyframes with previs depth control`}`,
    `- ${t`Video: MiniMax H3 on Colab, lip-synced to the dubbed lines`}`,
  ];
  const path = `${productionDirectory(production.id)}/report.md`;
  await writeProductionText(cwd, path, `${lines.join("\n")}\n`);
  return path;
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

/** The estimate of a production in this workspace, without the LoRAs it will reuse from earlier work. */
export async function quoteProduction(cwd: string, input: Pick<ProductionInput, "seconds" | "quality" | "photos">) {
  return estimateProduction(input, await peopleWithLoras(cwd, input.photos.map(photo => photo.name)), await costRatio());
}

export async function createProduction(cwd: string, id: string, input: ProductionInput) {
  const now = new Date().toISOString();
  await saveProduction(cwd, {
    toonflowProduction: 1, id, createdAt: now, updatedAt: now, input, status: "running", approved: [],
    estimate: (await quoteProduction(cwd, input)).total,
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
