import { translate } from "@toonflow/i18n";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotListFixPrompt, shotListInstructions } from "@toonflow/node-shared/shotListPrompt";
import { t } from "@/lib/i18n";
import { getConfiguredModel, holdColab, holdColabFor, listAiModels, streamAi } from "@/utils/ai";
import { readColabBalance } from "@/utils/media/colab";
import { meteredColabUnits } from "@/utils/media/usage";
import { warmMinimaxH3 } from "@/utils/media/minimaxH3";
import { holdQwenImage } from "@/utils/media/qwenImage";
import { assetDrawn, castPrompt, drawAssets, drawPoses, parseCast, peopleWithLoras, planAssetLoras, trainAssetLoras } from "./assets";
import { planDub, recordDub } from "./dub";
import { planPrevis, renderPrevis } from "./previs";
import { applyDiagnosis, diagnosisPrompt, keepBest, readDiagnosis } from "./review";
import { clipCheckPrompt, clipFrames, finishFilm, joinRoughCut, readClipCheck, renderClips, scoreFilm, writeClipPrompts } from "./video";
import { costRatio, estimateProduction, recordProductionCost } from "./estimate";
import { planShots, referenceImages, shotReferences } from "./shots";
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

/**
 * Starts the text model's L4 and loads the model with a one-word request while other work runs, so the checks that
 * follow find it ready; it is held for at most `ms`, until `signal` aborts or the returned release is called.
 */
function warmTextModel(ms: number, signal: AbortSignal) {
  const release = holdColabFor(ms, signal);
  void complete("Reply with one word.", "Ready?", signal).catch(() => {});
  return release;
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
 * What the production has spent since it started: the drop of the account balance, in which other Colab jobs running
 * meanwhile count too, or the compute units metered meanwhile, which count a session while it runs, where the balance
 * shows it only minutes after it ends; whichever is more.
 */
async function spentUnits(production: Production, signal: AbortSignal) {
  const balance = await readColabBalance(signal);
  const metered = meteredColabUnits();
  production.balanceAtStart ??= balance;
  production.meterAtStart ??= metered;
  return Math.max(production.balanceAtStart - balance, metered - production.meterAtStart);
}

/** Whether the budget has room for `units` more, for work worth starting early only when what follows is affordable. */
const affordable = (production: Production, units: number, signal: AbortSignal) =>
  spentUnits(production, signal).then(spent => spent + units <= production.input.budget, () => false);

/** Stops before a step that would take the production past its budget; it never spends on a guess when the spend cannot be read. */
async function withinBudget(cwd: string, production: Production, nextUnits: number, signal: AbortSignal) {
  const spent = await spentUnits(production, signal).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  if (spent instanceof Error) return wait(cwd, production, "balanceUnreadable", undefined, spent.message);
  if (spent + nextUnits > production.input.budget) return wait(cwd, production, "budget");
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
  // The shots and the dub are planned from the shot list and the cast alone, before anything is drawn, so the texts
  // written from them can follow the previs plan at once.
  if (!production.shots) {
    production.shots = planShots(await readProductionText(cwd, production.shotList), production.assets);
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.dub) {
    production.dub = planDub(await readProductionText(cwd, production.shotList), production.assets);
    await saveProduction(cwd, production);
    return true;
  }
  // Every shot is blocked in previs before its clip, as Code Video Model renders its proxy first: the text model, still warm from the cast, plans the film's staging in one reply and the Director's Studio
  // code builds and frames every shot in a headless Chrome. The plan comes first because it says who each shot shows,
  // which decides who is seen often enough for a LoRA.
  if (!production.previs) {
    if (!await withinBudget(cwd, production, estimate.steps.find(item => item.step === "text")!.units, signal)) return false;
    const model = textModel();
    const shotList = await readProductionText(cwd, production.shotList);
    production.previs = await planPrevis(cwd, production, await readProductionText(cwd, production.script), shotList, { providerId: model.providerId, modelId: model.modelId }, signal);
    await saveProduction(cwd, production);
    return true;
  }
  // Designs and their LoRAs, the dub, the texts and the previs renders run side by side on separate machines, the
  // budget checked once for all; the clips start when all are done. Only the LoRAs actually trained count against
  // the budget; reused and skipped ones cost nothing. The text model, still warm from the previs plan, is held until
  // every text written from the plan is done, so none of them starts a machine of its own later, and released then,
  // while the designs, LoRAs and previs renders, which take far longer, go on without it.
  // Dubbing comes before the clip prompts: H3 lip-syncs to each shot's track, and a shot is as long as its lines need.
  // Gemini TTS bills its own API, not Colab units.
  const everyAsset = [...production.assets.characters, ...production.assets.places];
  const drawn = everyAsset.every(assetDrawn);
  const trained = everyAsset.every(item => item.loras);
  const rendered = production.previs.every(item => item.video);
  const posed = production.previs.every(item => Object.keys(item.poses ?? {}).every(name => production.shots!.find(shot => shot.shot === item.shot)?.poses?.[name]));
  const writing = textsMissing(production);
  if (!drawn || !trained || !rendered || !posed || !production.clips || writing) {
    const shotList = await readProductionText(cwd, production.shotList);
    const plan = trained ? undefined : await planAssetLoras(cwd, production, shotList);
    const units = (drawn ? 0 : estimate.steps.find(item => item.step === "assets")!.units) + (plan?.units ?? 0)
      + (writing ? estimate.steps.find(item => item.step === "text")!.units : 0);
    if (units && !await withinBudget(cwd, production, units, signal)) return false;
    const save = () => saveProduction(cwd, production);
    // The trigger words the LoRAs are planned with are kept before the clip prompts name them.
    await save();
    const release = writing ? holdColab() : () => {};
    const clipUnits = estimate.steps.find(item => item.step === "clips")!.units;
    let releaseH3 = () => {};
    // The Qwen-Image machine stays on from the designs to the poses drawn from them, so the poses never start their own;
    // for 15 minutes at most, should the previs renders the poses wait for stall.
    const releaseQwen = holdQwenImage(15 * 60_000, signal);
    try {
      const dubbed = production.clips ? Promise.resolve() : recordDub(cwd, production, signal, save).then(clips => {
        production.clips = clips;
        return save();
      });
      const drawing = drawn ? Promise.resolve() : drawAssets(cwd, production, production.input.ratio, signal, save);
      const designed = drawing.then(() => plan && trainAssetLoras(cwd, plan, signal, save));
      const blocked = (async () => {
        if (rendered) return;
        await renderPrevis(cwd, production, shotList, signal);
        await save();
      })();
      // Each person's opening pose needs only their design and the previs figure, so it is drawn while the LoRAs train.
      const posing = Promise.all([drawing, blocked]).then(() => drawPoses(cwd, production, signal, save)).finally(releaseQwen);
      // Once the designs, LoRAs, previs renders and poses are done, only texts are left before the clips, and Qwen-Image
      // has freed its machine slot: the H3 A100s start and set up meanwhile, when the budget has room for the clips too.
      const warmed = Promise.all([designed, blocked, posing]).then(async () => {
        // Only the first pass warms them: a correction round rewrites a few prompts and renders those clips on one
        // machine started on demand.
        if (!production.videos && await affordable(production, (writing ? estimate.steps.find(item => item.step === "text")!.units : 0) + clipUnits, signal)) {
          releaseH3 = warmMinimaxH3(production.input.quality, production.input.ratio, 20 * 60_000, signal);
        }
      });
      const results = await Promise.allSettled([designed, dubbed, writeTexts(cwd, production, dubbed, signal).finally(release), blocked, posing, warmed]);
      // All are awaited before an error is passed on, so nothing keeps running unwatched.
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      release();
      releaseQwen();
      releaseH3();
    }
    return true;
  }

  // The clips render once, at the chosen quality: no one reviews a cheaper pass before the film, and rendering every clip
  // twice doubled the longest step.
  const videos = production.videos!;
  const unrendered = videos.filter(item => !item.video).length;
  if (unrendered) {
    // ACT: The clips still to render take their share of the step's estimate; a clip rendered again after its check is
    // one share. The machine start in the estimate is shared out too, so a lone retry on a cold machine is undercounted.
    const clipUnits = estimate.steps.find(item => item.step === "clips")!.units;
    // Corrections the budget can no longer pay for keep their best render, so the film is still finished; a clip never
    // rendered waits for the budget.
    if (videos.every(item => item.video || item.attempts?.length) && !await affordable(production, clipUnits * unrendered / videos.length, signal)) {
      for (const item of videos.filter(item => !item.video)) keepBest(item);
      await saveProduction(cwd, production);
      return true;
    }
    if (!await withinBudget(cwd, production, clipUnits * unrendered / videos.length, signal)) return false;
    // Each clip is checked by the text model once rendered, so its L4 starts while they render.
    const releaseText = warmTextModel((10 + unrendered * 3) * 60_000, signal);
    try {
      await renderClips(cwd, production, videos, production.input.quality, "clips", signal, () => saveProduction(cwd, production));
    } finally {
      releaseText();
    }
    return true;
  }
  // Each clip is checked against its row, previs and references by the model reading frames of it. A clip that fails is
  // diagnosed from the same frames: one the check judged wrongly passes, any other is written again knowing what failed
  // and why, and rendered from the new prompt, up to maxCorrections times, after which the best render stays, flagged
  // for a person to look at. Never the same prompt with a new seed, which fails the same way.
  const unchecked = videos.filter(item => !item.check);
  if (unchecked.length) {
    const textUnits = estimate.steps.find(item => item.step === "text")!.units;
    if (!await withinBudget(cwd, production, textUnits, signal)) return false;
    // A correction costs a clip's share of the clip and text steps; one the budget cannot pay for is not started.
    const correctionUnits = (estimate.steps.find(item => item.step === "clips")!.units + textUnits) / videos.length;
    // The clips are checked and diagnosed side by side, as the text model answers two requests at once; the verdicts
    // are kept until all are in and then applied in shot order, as each correction draws on the budget the ones before
    // it left. Every clip is awaited before an error is passed on, so none goes on unwatched.
    const verdicts = await Promise.allSettled(unchecked.map(async item => {
      const shot = production.shots!.find(other => other.shot === item.shot)!;
      const previs = production.previs!.find(other => other.shot === item.shot)!;
      const references = shotReferences(shot, production.assets!, previs.framed);
      const frames = await clipFrames(cwd, production, item, [previs.layout!, ...referenceImages(references)], signal);
      const gazes = Object.entries(previs.framed.gaze).map(([name, gaze]) => `${name}: ${gaze}`).join(" | ");
      const looks = references.people.length + (references.place ? 1 : 0);
      const ask = async () => readClipCheck(await complete(checker, clipCheckPrompt(item.prompt ?? "", shot.row ?? "", gazes, looks), signal, frames));
      // A reply that cannot be read is asked again once; one unreadable twice stays failed for a person, never diagnosed,
      // so a parsing failure neither passes a clip nor pays for a render.
      let check = await ask();
      if (check.unreadable) check = await ask();
      const diagnosis = !check.passed && !check.unreadable
        ? readDiagnosis(await complete(checker, diagnosisPrompt(production, { ...item, check }, shot.row ?? "", gazes, looks), signal, frames)) : undefined;
      return { item, check, diagnosis };
    }));
    const failure = verdicts.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    let corrections = 0;
    for (const { item, check, diagnosis } of verdicts.flatMap(result => result.status === "fulfilled" ? [result.value] : [])) {
      item.check = check;
      if (diagnosis) {
        applyDiagnosis(production, item, diagnosis, await affordable(production, correctionUnits * (corrections + 1), signal));
        if (!item.check) corrections++;
      }
    }
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.roughCut) {
    production.roughCut = await joinRoughCut(cwd, production, signal);
    await saveProduction(cwd, production);
    return true;
  }

  // Suno bills the sunoapi.org account, so the score is made only once every clip is rendered; its style was written
  // with the other texts.
  if (production.input.music && !production.music) {
    production.music = await scoreFilm(cwd, production, production.musicStyle!, production.clips!.reduce((sum, item) => sum + item.clip, 0), signal);
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

const videoWriter = "You write prompts for the MiniMax H3 video model.";
const composer = "You describe film scores for a music generation model.";
const checker = "You check AI-generated video clips for a film editor.";
/** Whether a text written from the previs plan is missing: a clip prompt or the music's style. */
const textsMissing = (production: Production) => !production.videos || production.videos.some(item => !item.prompt) || (production.input.music && !production.musicStyle);

/**
 * Writes the texts the previs plan allows that the production still lacks: once the dub has set each shot's length, the
 * clip prompts from the previs blocking, and the style of the music.
 */
async function writeTexts(cwd: string, production: Production, dubbed: Promise<unknown>, signal: AbortSignal) {
  const [script, shotList] = await Promise.all([readProductionText(cwd, production.script!), readProductionText(cwd, production.shotList!)]);
  const save = () => saveProduction(cwd, production);
  // ACT: The dub starts with the parallel step and is nearly always done by the time the text model is warm; a slower
  // one keeps the held text model waiting. Release the hold while waiting if dubs ever run that long.
  await dubbed;
  await writeClipPrompts(production, script, shotList, prompt => complete(videoWriter, prompt, signal), save);
  if (production.input.music && !production.musicStyle) {
    production.musicStyle = await complete(composer, musicPrompt(script, production.clips!.reduce((sum, item) => sum + item.clip, 0)), signal);
    await save();
  }
}

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
  const spent = await spentUnits(production, signal).then(units => units.toFixed(2), () => "?");
  if (spent !== "?") await recordProductionCost(production.estimate, Number(spent));
  const clips = production.videos!;
  const loras = [...production.assets!.characters, ...production.assets!.places].flatMap(asset => (asset.loras ?? []).map(lora => `| ${asset.name} | ${lora.family} | ${lora.trigger} | ${lora.path} |`));
  const lines = [
    `# ${t`Production report`}`,
    "",
    t`Film: ${production.film}, ${production.input.quality}, ${clips.length} shots.`,
    t`Colab compute units: ${spent} spent of a ${production.input.budget} budget (estimate ${production.estimate}).`,
    t`Dialogue: Gemini TTS, billed by the Google account.`,
    ...production.music ? [t`Music: Suno V6, billed by the sunoapi.org account.`] : [],
    "",
    `## ${t`Shots`}`,
    "",
    `| ${t`Shot`} | ${t`Clip`} | ${t`Clip seed`} |`,
    "| --- | --- | --- |",
    ...clips.map(clip => `| ${clip.shot} | ${clip.video ?? ""} | ${clip.seed ?? ""} |`),
    "",
    `## ${t`LoRAs`}`,
    "",
    ...loras.length ? [`| ${t`Name`} | ${t`Model`} | ${t`Trigger word`} | ${t`File`} |`, "| --- | --- | --- | --- |", ...loras] : [t`None.`],
    "",
    `## ${t`Models`}`,
    "",
    `- ${t`Script, shot list and prompts: ${textModel().modelId} on Colab`}`,
    `- ${t`Designs: Qwen-Image 2.1 Turbo on Colab`}`,
    `- ${t`Video: MiniMax H3 on Colab from the previs and the designs as references, lip-synced to the dubbed lines`}`,
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
