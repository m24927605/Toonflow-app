import { translate } from "@toonflow/i18n";
import { z } from "zod";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, replaceShotCells, shotSpans } from "@toonflow/node-shared/shotList";
import { shotListFixPrompt, shotListInstructions, storyScopeInstructions, uncensoredTextModelId, visualTextModelId } from "@toonflow/node-shared/shotListPrompt";
import { t, getLocale, runWithLocale, translateMessage } from "@/lib/i18n";
import { getConfiguredModel, holdColab, listAiModels, streamAi, colabModelPreparation } from "@/utils/ai";
import { readColabBalance } from "@/utils/media/colab";
import { holdColabPool, inspectColabPool, colabModelPrepared, markColabModelPrepared, colabLane, colabPoolIdle, withColabAllocation, type ColabPreparation } from "@/utils/media/colabPool";
import { meteredColabUnits } from "@/utils/media/usage";
import { holdSulphur, limitSulphur, maxClipSeconds, maxTakeSeconds, warmSulphur, sulphurPreparation } from "@/utils/media/sulphur";
import { holdQwenImage, qwenImagePreparation } from "@/utils/media/qwenImage";
import { maxWanRemixSeconds } from "@/utils/media/wanRemix";
import { preparationKey, prepareModels, registerModelCaches, saveModelCaches } from "@/utils/media/preparation";
import { applySpeakerLabels, missingSpeakerLabels, speakerLabelsJsonSchema, planJsonSchema, planPrompt, readPlan, requireCurrentPlan } from "./plan";
import { executionAllocation, executionSource, planExecution, planStartup, startupAllocation } from "./execution";
import { requireJevKey } from "@/utils/ai/jev";
import { castPrompt, drawAssets, parseCast, planAssetLoras, reuseDesigns, trainAssetLora, castJsonSchema, emptyEnvironmentRule } from "./assets";
import { applyDialogueTiming, clipSeconds, DialogueTimingError, dialogueTimingSchema, fitDialogueTiming, planDub, recordDub } from "./dub";
import { planPrevis, renderPrevis, cameraMeasurements, previsCastIssues } from "./previs";
import { ReplyCutError, replyJson } from "./review";
import { ambiencePrompt, generateAmbience } from "./ambience";
import { continuedFrom, finishFilm, joinRoughCut, renderClips, prepareClipInputs, takeStartFrame, validateFilm, scoreFilm, writeClipPrompts, type ProductionClip } from "./video";
import { costRatio, estimateProduction, recordProductionCost } from "./estimate";
import { checkImages, clipCheckPrompt, majorProblems, readCheck } from "./checks";
import { drawKeyframe } from "./keyframes";
import { planShots, shotReferences } from "./shots";
import { readConversation, updateConversation } from "./conversation";
import { validateReferenceAttachments, planReferences, applyAudioReferences, type ReferenceAttachment } from "./references";
// Official QwenLM/Qwen-Image-2.1 prompt rewriter, revision ab96caa944157ca28a4f36b695c3047549f48f98.
import qwenImageTextPrompt from "./qwenImageTextPrompt.txt" with { type: "text" };
import {
  assetDrawn, productionDirectory, productionGuidance, productionProgress, readProduction, readProductionText, readRegistry, saveProduction, setRegistered, writeProductionText,
  type Production, type ProductionGate, type ProductionInput,
} from "./state";

// Qwen generates content; Jev selects execution resources. Quality checks are deterministic.
const runners = new Map<string, { controller: AbortController; finished: Promise<void> }>();
const runnerKey = (cwd: string, id: string) => JSON.stringify([cwd, id]);
type RuntimeOwner = { release: () => void; started?: boolean; preparation?: { state: NonNullable<Production["runtime"]>; roles: Map<string, Promise<void>>; groups: Map<number, Promise<void>>; textReady: Promise<void>; allReady: Promise<void>; cancel: () => void; textRecorded: boolean; extrasStarted: boolean } };
const runtimeOwners = new Map<string, RuntimeOwner>();
const conversationReplies = new Map<string, Promise<void>>();
const continuations = new Set<string>();
let startingSimpleProduction = false;
export const productionWorkPending = () => !!(runners.size || conversationReplies.size || continuations.size || startingSimpleProduction);

async function resetScriptOutputs(cwd: string, production: Production) {
  const runtime = runtimeOwners.get(runnerKey(cwd, production.id));
  const preparing = runtime?.preparation;
  if (preparing) {
    preparing.extrasStarted = false;
    delete preparing.state.readyAt;
    await writeProductionText(cwd, `${productionDirectory(production.id)}/runtimePreparation.json`, JSON.stringify(preparing.state));
  }
  if (production.assets) production.previousAssets = production.assets;
  if (production.dub) production.previousDub = production.dub;
  for (const field of ["shotList", "assets", "references", "plan", "execution", "shots", "dub", "previs", "videos", "roughCut", "clips", "musicStyle", "music", "ambience", "film", "report"] as const) delete production[field];
}

async function releaseRuntime(key: string, preserveCache = false) {
  const runtime = runtimeOwners.get(key);
  if (!runtime) return;
  runtime.preparation?.cancel();
  if (runtime.preparation) await Promise.allSettled([runtime.preparation.allReady]);
  runtime.release();
  runtimeOwners.delete(key);
  if (preserveCache && !runtimeOwners.size && colabPoolIdle()) await saveModelCaches(AbortSignal.timeout(120_000));
}

async function prepareRuntime(cwd: string, production: Production, signal: AbortSignal) {
  const runtime = runtimeOwners.get(runnerKey(cwd, production.id))!;
  configuredModel(uncensoredTextModelId);
  configuredModel(visualTextModelId);
  const path = `${productionDirectory(production.id)}/runtimePreparation.json`;
  if (!runtime.preparation) {
    const controller = new AbortController();
    const preparationSignal = AbortSignal.any([signal, controller.signal]);
    const state = production.runtime ?? { machines: [], models: [] };
    delete state.readyAt;
    state.machines = [];
    const checkpoint = () => writeProductionText(cwd, path, JSON.stringify(state));
    const ready = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const prepareGroup = async (lane: number, items: ColabPreparation[]) => {
      await registerModelCaches(lane, items);
      const missing = items.filter(item => !colabModelPrepared(colabLane(lane), preparationKey(item)));
      for (const item of items.filter(item => !missing.includes(item))) ready.get(item.name)!.resolve();
      if (!missing.length) return;
      await prepareModels(lane, missing, preparationSignal, async timing => {
        state.models.push(timing);
        const item = missing.find(item => item.name === timing.name);
        if (item && timing.passed) await markColabModelPrepared(colabLane(lane), preparationKey(item));
        await checkpoint();
        if (item && timing.passed) ready.get(item.name)!.resolve();
      });
    };
    const groups = new Map<number, ColabPreparation[]>();
    const add = (lane: number, item: ColabPreparation) => groups.set(colabLane(lane), [...groups.get(colabLane(lane)) ?? [], item]);
    add(0, colabModelPreparation(uncensoredTextModelId));
    add(1, sulphurPreparation(production.input.quality, production.input.ratio));
    add(1, qwenImagePreparation([]));
    // The vision model that checks keyframes and clips is only downloaded here; it loads at its first check, after the
    // lines are recorded on the same A100.
    add(3, { ...colabModelPreparation(visualTextModelId), deferLoad: true });
    for (const items of groups.values()) for (const item of items) {
      const role = Promise.withResolvers<void>();
      void role.promise.catch(() => {});
      ready.set(item.name, role);
    }
    const tasks = [...groups].map(([lane, items]) => ({ lane, task: prepareGroup(lane, items).catch(error => {
      controller.abort(error);
      for (const item of items) ready.get(item.name)!.reject(error);
      throw error;
    }) }));
    const textReady = tasks.find(item => item.lane === 0)!.task;
    const allReady = (async () => {
      const results = await Promise.allSettled(tasks.map(item => item.task));
      const failed = results.find(item => item.status === "rejected");
      if (failed) throw failed.reason;
      state.machines = await inspectColabPool(preparationSignal, [...groups.keys()]);
      await checkpoint();
    })();
    void allReady.catch(async error => {
      if (signal.aborted) return;
      state.failure = error instanceof Error ? error.message : String(error);
      try { await checkpoint(); }
      finally { runners.get(runnerKey(cwd, production.id))?.controller.abort(error); }
    }).catch(error => console.error("[production] Could not save background preparation failure:", error));
    runtime.preparation = { state, roles: new Map([...ready].map(([name, role]) => [name, role.promise])), groups: new Map(tasks.map(item => [item.lane, item.task])), textReady, allReady, cancel: () => controller.abort(), textRecorded: false, extrasStarted: false };
  }
  const preparing = runtime.preparation;
  production.runtime = preparing.state;
  if (!preparing.textRecorded) {
    await timed(cwd, production, "startupText", () => preparing.textReady);
    preparing.textRecorded = true;
  }
  if (!production.execution || preparing.extrasStarted) return;
  preparing.extrasStarted = true;
  const initialReady = preparing.allReady;
  const start = new Date().toISOString(), began = performance.now();
  preparing.allReady = initialReady.then(() => {
    preparing.state.readyAt = new Date().toISOString();
  }).finally(async () => {
    (preparing.state.timings ??= []).push({ step: "startupMedia", start, end: new Date().toISOString(), seconds: (performance.now() - began) / 1000 });
    await writeProductionText(cwd, path, JSON.stringify(preparing.state));
  });
  void preparing.allReady.catch(async error => {
    if (signal.aborted) return;
    preparing.state.failure = error instanceof Error ? error.message : String(error);
    await writeProductionText(cwd, path, JSON.stringify(preparing.state));
    runners.get(runnerKey(cwd, production.id))?.controller.abort(error);
  }).catch(error => console.error("[production] Could not save preparation failure:", error));
}

function configuredModel(modelId: string) {
  const model = listAiModels().find(item => item.modelId === modelId);
  if (!model) throw new Error(`Add the Colab CLI provider with ${modelId} in Settings first`);
  return model;
}

/**
 * Asks the text-generation model. A
 * reply cut off at the length limit, such as one caught in a loop, is asked for once more; cut off again, it fails
 * rather than pass as an answer.
 */
async function complete(systemPrompt: string, prompt: string, signal: AbortSignal, { schema }: { schema?: Record<string, unknown> } = {}, tries = 2): Promise<string> {
  const model = configuredModel(uncensoredTextModelId);
  const stream = await streamAi(getConfiguredModel(model.providerId, model.modelId), { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] }, signal, [], undefined, schema);
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "Model request failed");
  if (message.stopReason === "length") {
    if (tries > 1) return complete(systemPrompt, prompt, signal, { schema }, tries - 1);
    throw new ReplyCutError("The text model's reply was cut off at its length limit twice");
  }
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
}

/**
 * Asks the vision model about images (PNG bytes as base64), which it reads after the prompt; the text model misread
 * frames (a dark jacket taken for a white shirt). A reply cut off twice fails like a text reply.
 */
async function see(systemPrompt: string, prompt: string, images: string[], signal: AbortSignal, tries = 2): Promise<string> {
  const model = configuredModel(visualTextModelId);
  const content = [{ type: "text" as const, text: prompt }, ...images.map(data => ({ type: "image" as const, data, mimeType: "image/png" }))];
  const stream = await streamAi(getConfiguredModel(model.providerId, model.modelId), { systemPrompt, messages: [{ role: "user", content, timestamp: Date.now() }] }, signal);
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "Model request failed");
  if (message.stopReason === "length") {
    if (tries > 1) return see(systemPrompt, prompt, images, signal, tries - 1);
    throw new ReplyCutError("The vision model's reply was cut off at its length limit twice");
  }
  return message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("").trim();
}
const checker = "You check AI-generated film frames for a film editor.";
// How many times a clip whose check fails is written and rendered again.
const clipCorrections = 2;

/** The vision model's check of a rendered clip against its row, its keyframe and the designs of its people and place. */
async function checkClip(cwd: string, production: Production, item: ProductionClip, look: (prompt: string, images: string[]) => Promise<string>, signal: AbortSignal) {
  const shot = production.shots!.find(other => other.shot === item.shot)!;
  const previs = production.previs!.find(other => other.shot === item.shot)!;
  const { people, place } = shotReferences(shot, production.assets!, previs.framed);
  const references = [place.place.base!, ...people.map(({ person }) => person.outfits?.find(outfit => outfit.name === shot.outfits[person.name])?.views?.[0] ?? person.base!)];
  const seconds = production.dub!.shots.find(other => other.shot === item.shot)!.seconds;
  const images = await checkImages(cwd, production, `shot${item.shot}Take${(item.attempts?.length ?? 0) + 1}`, references, { video: item.video!, seconds }, signal);
  const ask = async () => readCheck(await look(clipCheckPrompt(shot.row ?? "", item.prompt ?? "", references.length), images));
  const check = await ask();
  return check.unreadable ? ask() : check;
}

export async function createSimpleProduction(cwd: string, id: string, outline: string, fromConversation: boolean, references: ReferenceAttachment[] = [], referenceNotes: string[] = []) {
  if (startingSimpleProduction || runners.size) throw Object.assign(new Error(translateMessage("另一支影片正在製作，這次先保留討論內容，尚未開始新製作。")), { status: 409 });
  startingSimpleProduction = true;
  try {
    const input: ProductionInput = { outline, mode: "simple", fromConversation, modelRecipe: "sulphur2", references, referenceNotes, seconds: 30, ratio: "16:9", quality: "720p", gates: [], photos: [], subtitles: false, music: false };
    return await createProduction(cwd, id, input);
  } finally { startingSimpleProduction = false; }
}

/** Conversation reads never resume a stopped film. */
export async function getProductionConversation(cwd: string, id: string) {
  const production = await readProduction(cwd, id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (production && production.input.mode !== "simple") throw Object.assign(new Error("This conversation belongs to simple mode"), { status: 400 });
  const conversation = await readConversation(cwd, id);
  if (!conversationReplies.has(runnerKey(cwd, id))) for (const turn of conversation.turns) if (turn.status === "pending") {
    turn.status = "failed";
    turn.error = translateMessage("回覆已中斷，請查看目前製作進度。");
  }
  return conversation;
}

/** Store a user turn separately while production continues at its own safe boundaries. */
export async function sendProductionMessage(cwd: string, id: string, messageId: string, message: string, action: "chat" | "start", attachments: ReferenceAttachment[] = []) {
  attachments = await validateReferenceAttachments(cwd, id, attachments);
  const sameContent = (turn: { message: string; attachments?: ReferenceAttachment[]; productionRequested?: true }) => turn.message === message && !!turn.productionRequested === (action === "start") && JSON.stringify(turn.attachments ?? []) === JSON.stringify(attachments);
  const key = runnerKey(cwd, id);
  if (conversationReplies.has(key)) {
    const prior = (await readConversation(cwd, id)).turns.find(turn => turn.id === messageId);
    if (prior && sameContent(prior)) return;
    throw Object.assign(new Error(translateMessage("AI 正在回覆上一則訊息，請稍候。")), { status: 409 });
  }
  const pending = Promise.withResolvers<void>();
  conversationReplies.set(key, pending.promise);
  const finish = () => { if (conversationReplies.get(key) === pending.promise) conversationReplies.delete(key); pending.resolve(); };
  try {
    const production = await readProduction(cwd, id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    const runner = runners.get(key);
    if (production && production.input.mode !== "simple") throw Object.assign(new Error("This conversation belongs to simple mode"), { status: 400 });
    const locale = getLocale();
    const replyNeeded = await updateConversation(cwd, id, conversation => {
      const prior = conversation.turns.find(turn => turn.id === messageId);
      if (prior && !sameContent(prior)) throw Object.assign(new Error("Message ID already belongs to different content"), { status: 409 });
      if (!prior && new Set([...conversation.turns.flatMap(turn => turn.attachments ?? []), ...attachments].map(item => item.path)).size > 10) throw Object.assign(new Error("每段聊天最多使用 10 個參考附件。"), { status: 400 });
      if (prior?.status === "answered") return false;
      for (const turn of conversation.turns) if (turn.status === "pending") { turn.status = "failed"; turn.error = translateMessage("回覆已中斷，請查看目前製作進度。"); }
      if (prior) { prior.status = "pending"; prior.locale = locale; delete prior.error; delete prior.reply; delete prior.notice; }
      else conversation.turns.push({ id: messageId, at: new Date().toISOString(), locale, message, attachments, ...action === "start" ? { productionRequested: true as const } : {}, status: "pending" });
      return true;
    });
    if (!replyNeeded) { finish(); return; }
    const signal = action === "start" && runner && !runner.controller.signal.aborted ? AbortSignal.any([runner.controller.signal, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000);
    void runWithLocale(locale, async () => {
      const release = holdColab();
      const started = performance.now();
      try {
        if (action === "start") await runtimeOwners.get(key)?.preparation?.textReady;
        signal.throwIfAborted();
        const current = await readProduction(cwd, id).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        const conversation = await readConversation(cwd, id);
        const startRequested = action === "start";
        const authorizedTurns = startRequested ? conversation.turns.slice(0, conversation.turns.findIndex(turn => turn.id === messageId) + 1) : conversation.turns;
        const referenceFiles = [...new Map(authorizedTurns.flatMap(turn => turn.attachments ?? []).map(item => [item.path, item])).values()];
        if (!current && startRequested) {
          if (runners.size) {
            await updateConversation(cwd, id, state => { const turn = state.turns.find(turn => turn.id === messageId)!; turn.status = "answered"; turn.reply = translateMessage("另一支影片正在製作，這次先保留討論內容，尚未開始新製作。"); state.brief ??= message; });
            return;
          }
          let outline = message;
          if (conversation.turns.some(turn => turn.reply)) {
            const briefSchema = z.strictObject({ outline: z.string().trim().min(1).max(20000) });
            const compiled = await complete("Compile the creator-approved video brief from this discussion. Return the requested JSON. The latest user instruction overrides older ideas. Preserve explicit names, dialogue, duration, aspect ratio and spoken languages. Include assistant suggestions only when the user accepts them or leaves that creative choice to AI. Do not invent new facts or include the discussion itself as a film scene. Preserve reference filenames, their specified uses and exact creator-provided voice-reference transcripts. Keep the brief concise and in the story's language.", JSON.stringify({ draft: conversation.brief, history: conversation.turns.slice(-8).map(turn => ({ user: turn.message, attachments: turn.attachments, assistant: turn.reply })), latestMessage: message }), signal, { schema: z.toJSONSchema(briefSchema) });
            outline = briefSchema.parse(replyJson(compiled, "outline")).outline;
          }
          if (outline.length > 20000) throw new Error("Production brief exceeds 20000 characters");
          await updateConversation(cwd, id, state => { state.brief = outline; });
          await createSimpleProduction(cwd, id, outline, true, referenceFiles, authorizedTurns.map(turn => turn.message));
          await updateConversation(cwd, id, state => { const turn = state.turns.find(turn => turn.id === messageId)!; turn.status = "answered"; turn.started = true; turn.reply = translateMessage("已開始製作，進度會在這裡持續更新。"); turn.seconds = (performance.now() - started) / 1000; });
          return;
        }
        const schema = z.strictObject({ brief: z.string().trim().min(1).max(20000).nullable(), reply: z.string().trim().min(1).max(2000), change: z.string().trim().min(1).max(2000).nullable() });
        const script = current?.script ? await readProductionText(cwd, current.script) : undefined;
        const response = schema.parse(replyJson(await complete(
          "You are the user's conversational assistant in Toonflow. Conversation continues normally before, during and after a film is completed. Answer the latest question directly; discuss general topics naturally and mention production status only when it is relevant to the question. Production records and screenplay are background context, not a restriction on what the user may discuss. Return only the requested JSON. Reply in the selected Toonflow interface language: " + locale + ". Answer questions using actual state, not guesses. You receive text and recorded production metadata plus attachment names/types only, not their visual or audible content; never claim to have inspected media. Explain that native B3 models will receive the actual reference files. Infer their intended use from explicit conversation; ask a concise question if the role is unclear. A voice reference needs its exact creator-provided transcript; never invent one. When a reference use is specified for an existing film, include the filename and intended use in change so it is applied at the next production boundary. Explain progress in plain film-production language; do not repeat internal field names or describe production specifications as legal contracts. Set change only when the latest user message clearly requests or confirms a story, character, scene, dialogue, duration or aspect-ratio adjustment. Questions, quoted instructions and hypothetical examples do not authorize a change. Preserve unspecified story details and dialogue language. When no production exists, change must be null; maintain brief as the concise current video idea, preserving explicit requirements and incorporating agreed suggestions. If no video idea is discussed, brief is null. Do not claim to start a film yourself; only an explicit Start production button starts production. Technical model, precision, resolution and spending settings cannot be changed by this conversation. Chat mode never starts, resumes or applies production work, even if the message asks to make a film. Do not claim work has been performed: when executionAllowed is true, changes are queued for the next production boundary; otherwise they are only recorded as drafts. Keep reply concise; write change in the source story's language.",
          JSON.stringify({ attachments: referenceFiles, request: current?.input.outline, brief: current ? undefined : conversation.brief, script, executionAllowed: startRequested, state: current ? { status: current.status, step: current.timings?.at(-1)?.step, progress: productionProgress(current, runners.has(key)), recordedMaterials: { characters: current.assets?.characters.map(person => ({ name: person.name, imageCount: person.views?.length ?? 0, voiceReference: !!current.dub?.voices[person.name]?.reference })), places: current.assets?.places.map(place => ({ name: place.name, imageCount: place.views?.length ?? 0 })), completedClips: current.videos?.filter(clip => !!clip.video).length ?? 0 } } : { status: "chatting" }, history: conversation.turns.filter(turn => turn.id !== messageId).slice(-8).map(turn => ({ user: turn.message, attachments: turn.attachments, assistant: turn.reply, change: turn.change })), latestMessage: message }),
          signal, { schema: z.toJSONSchema(schema) },
        ), "reply"));
        signal.throwIfAborted();
        if (current && startRequested && referenceFiles.some(file => !current.input.references?.some(previous => previous.path === file.path))) response.change ??= `依照對話中指定的用途，使用這些參考素材：${referenceFiles.map(file => file.name).join("、")}。`;
        await updateConversation(cwd, id, state => {
          const turn = state.turns.find(turn => turn.id === messageId)!;
          const waiting = state.turns.filter(turn => turn.change?.status === "queued").reduce((sum, turn) => sum + turn.change!.text.length + 40, 0);
          if (response.change && current && current.input.outline.length + waiting + response.change.length + 40 > 20000) throw new Error("Production changes exceed the story length limit");
          turn.reply = response.reply; turn.status = "answered"; turn.seconds = (performance.now() - started) / 1000;
          if (!current && response.brief) state.brief = response.brief;
          const canExecute = current && (!runners.size || runners.has(key));
          if (current && response.change) {
            turn.change = { text: response.change, status: canExecute && startRequested ? "queued" : "draft" };
            if (startRequested) {
              turn.notice = true;
              turn.reply = translateMessage("已收到調整要求。");
            }
          }
          if (startRequested && current && response.change && !canExecute) turn.reply = translateMessage("目前無法啟動這次調整，討論內容已保留，請查看製作狀態。");
          if (startRequested && canExecute) for (const item of state.turns.slice(0, state.turns.findIndex(turn => turn.id === messageId) + 1)) if (item.change?.status === "draft") item.change.status = "queued";
        });
        if (current && startRequested) {
          const queued = (await readConversation(cwd, id)).turns.filter(turn => turn.change?.status === "queued").map(turn => turn.id);
          const resume = async () => {
            if (signal.aborted || runners.size || startingSimpleProduction) return;
            startingSimpleProduction = true;
            try {
              const latest = await readProduction(cwd, id);
              if (latest.message === "stopped" && current.message !== "stopped") return;
              if (queued.length && queued.every(messageId => latest.conversationChanges?.applied.includes(messageId))) return;
              if (!queued.length && !startRequested) return;
              if (!queued.length && latest.status === "done") resetShotInputs(latest, latest.shots?.map(shot => shot.shot) ?? [], false);
              await continueProduction(cwd, latest);
            } finally { startingSimpleProduction = false; }
          };
          const finishing = runners.get(key);
          if (finishing) void finishing.finished.then(resume).catch(error => console.error("[production] Could not continue conversation changes", { id, error: error instanceof Error ? error.name : "unknown" }));
          else await resume();
        }
      } catch (error) {
        await updateConversation(cwd, id, state => {
          const turn = state.turns.find(turn => turn.id === messageId)!;
          turn.status = "failed"; turn.error = translateMessage("訊息回覆未完成，請查看目前製作進度，或稍後重送。");
        });
        console.error("[production] Conversation reply failed", { id, error: error instanceof Error ? error.name : "unknown" });
      } finally { release(); finish(); }
    }).catch(error => { finish(); console.error("[production] Could not save conversation reply", { id, error: error instanceof Error ? error.name : "unknown" }); });
  } catch (error) { finish(); throw error; }
}

/** Commit requested changes once, between stages, before another worker takes a production snapshot. */
async function applyConversationChanges(cwd: string, id: string, signal: AbortSignal) {
  const conversation = await readConversation(cwd, id);
  if (!conversation.turns.some(turn => turn.change?.status === "queued" || turn.change?.status === "applying")) return false;
  return updateConversation(cwd, id, async state => {
    signal.throwIfAborted();
    const production = await readProduction(cwd, id);
    const checkpoint = production.conversationChanges ??= { requested: [], applied: [] };
    for (const turn of state.turns) if (turn.change && checkpoint.applied.includes(turn.id)) turn.change.status = "applied";
    const changes = state.turns.filter(turn => turn.change?.status === "queued" && !checkpoint.requested.includes(turn.id));
    for (const turn of state.turns) if (turn.change && checkpoint.requested.includes(turn.id) && !checkpoint.applied.includes(turn.id)) turn.change.status = "applying";
    if (!changes.length) return false;
    const notes = changes.map(turn => turn.change!.text).join("\n\n");
    const updated = production.input.outline + "\n\nCreator clarification:\n" + notes;
    if (updated.length > 20000) throw new Error("Production changes exceed the story length limit");
    production.originalOutline ??= production.input.outline;
    production.input.outline = updated;
    const authorized = state.turns.slice(0, state.turns.findLastIndex(turn => turn.productionRequested) + 1);
    production.input.references = [...new Map(authorized.flatMap(turn => turn.attachments ?? []).map(item => [item.path, item])).values()];
    production.input.referenceNotes = authorized.map(turn => turn.message);
    if (production.script) production.review = { gate: "script", notes: [production.review?.notes, notes].filter(Boolean).join("\n\n") };
    delete production.direction; delete production.execution;
    production.status = "running"; production.message = undefined; production.detail = undefined;
    checkpoint.requested.push(...changes.map(turn => turn.id));
    signal.throwIfAborted();
    await saveProduction(cwd, production);
    for (const turn of changes) turn.change!.status = "applying";
    return true;
  });
}

async function writeImagePrompt(brief: string, ratio: string, signal: AbortSignal) {
  const schema = z.strictObject({ rewritten_prompt: z.string().trim().min(1).refine(value => !/[\r\n]/.test(value), "The image prompt must be one paragraph"), wh_ratio: z.literal(ratio) });
  const reply = await complete(`${qwenImageTextPrompt}\n\nProduction constraints override open-ended embellishment: preserve the supplied subject, environment, wardrobe and fixed ratio. Follow the brief's asset role: an empty environment plate has no actors; a character design contains only its specified person. Describe only necessary visible details in one concise paragraph; omit repetitive quality phrases and invented objects. The creator requests concise prompts, so do not pad to a word count. Keep ratio and resolution out of rewritten_prompt. When repair findings are supplied, revise the previous prompt to address them.`, brief, signal, { schema: z.toJSONSchema(schema) });
  return schema.parse(replyJson(reply, "rewritten_prompt")).rewritten_prompt;
}

const screenwriter = "You write screenplays for short films made with AI image and video models.";
// How long people take to play common actions at a natural pace, for planning beats and checking shots against them.
const beatPacing = "a look, a reaction or a short line takes 2–4 s, a walk across a room or taking off one garment 4–6 s, a kiss or a sexual position with its rhythm 5–10 s";

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
    storyScopeInstructions,
    `Write the complete screenplay of a short film of ${input.seconds} seconds from the outline below.`,
    "Keep the outline's people, places and events, and add only what the story needs to play out. Call every person and place exactly by the name the outline uses; never rename or translate a name or add a reading or translation after it.",
    "Preserve every explicitly required object, its relationship to the actors, timing and exclusions in the outline. Include required static furniture in the place descriptions as well as the scene action.",
    `The film lasts ${input.seconds} seconds: every line is spoken aloud, so all dialogue together must take at most half of that time.`,
    `Plan the film as visible beats that together take its ${input.seconds} seconds. A beat is one action people can play in full at a natural pace: ${beatPacing}. Keep only the events that fit, and never stack several actions into one moment. Give each event the share of the film its weight in the outline asks for: when the outline centres on sex, the sex acts take most of the film, each position held long enough to show its rhythm.`,
    `Start with a section listing the characters: each person's fixed name, their look (age, build, face, hair), intended audible voice (presentation, apparent age, timbre, language/dialect and delivery), and every outfit they wear in the story, each with a short name such as "home clothes" and a description; then a section listing the places, each with a fixed name and its empty environment look; then the scenes: a heading, the action in present tense naming the outfit when someone changes, and dialogue as "Name: line". Title the sections in ${language}.`,
    ...named.length ? [`These characters have photos, so use exactly these names for them: ${named.join(", ")}.`] : [],
    `Write section titles, scene headings and action in ${language}. Explicit spoken-language requests override that default for dialogue. Output only the screenplay.`,
    "",
    "Outline:",
    input.outline,
    ...input.references?.length ? [`User reference files (content is not visible to the text model; use only the creator's descriptions): ${JSON.stringify(input.references)}`] : [],
  ].join("\n");
}

function revisionPrompt(script: string, notes: string) {
  const language = languageOf(script);
  return [
    `Preserve the existing screenplay and spoken languages (${language} by default), unless the requested changes explicitly require another language.`,
    `Rewrite the screenplay below to carry out the requested changes; they override anything in the screenplay. Keep unaffected lines verbatim, including their spoken languages.`,
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

/** Repair source cells before compiling the contract; keep all repairs within the shared allowance. */
async function compileProductionPlan(cwd: string, production: Production, script: string, original: string, signal: AbortSignal) {
  let shotList = original;
  let castFeedback = "";
  let dialogueFeedback = "";
  let contractProblem = "";
  let previousReply = "";
  const repairs = production.contractRepairs ??= [];
  const repairLimit = 5;
  const allowance = repairs.length + repairLimit;
  const known = new Set(production.assets!.characters.map(person => person.name));
  const repair = async (source: "shotList" | "contract", problem: string, prompt: string, schema: Record<string, unknown>) => {
    if (repairs.length >= allowance) throw new Error(`Production contract could not be repaired after ${repairLimit} attempts: ${problem}`);
    const record: NonNullable<Production["contractRepairs"]>[number] = { at: new Date().toISOString(), source, problem };
    repairs.push(record);
    await saveProduction(cwd, production);
    record.reply = await complete(shotListWriter, prompt, signal, { schema });
    await saveProduction(cwd, production);
    return record.reply;
  };
  for (;;) {
    signal.throwIfAborted();
    const checked = checkScript(shotList, production.input.seconds);
    const spans = shotSpans(checked.shots, shotList);
    const invalid = spans.flatMap(span => {
      const names = castNames(span);
      return names.some(name => !known.has(name)) || new Set(names).size !== names.length ? [`Shot ${span.shot}: invalid cast ${JSON.stringify(names)}; known character IDs ${JSON.stringify([...known])}`] : [];
    });
    if (invalid.length) {
      const problem = [...invalid, castFeedback].filter(Boolean).join("\n");
      const schema = z.strictObject({ shots: z.array(z.strictObject({ shot: z.number().int().positive(), cast: z.array(z.string().trim().min(1).max(1000)).max(known.size) })).length(spans.length) });
      const reply = await repair("shotList", problem, `Correct only the Cast cells. Return JSON {"shots":[{"shot":1,"cast":[]}]} for every shot in order. Cast contains visible performing characters, including partly visible characters. Ordinary cups, drinks, furniture and products are props, not actors; keep them in Action and State. A product-only shot has an empty cast. Keep every already-valid character ID, and preserve genuine story characters. Use only these character IDs: ${JSON.stringify([...known])}.\nProblems:\n${problem}\nScreenplay:\n${script}\nShot list:\n${shotList}`, z.toJSONSchema(schema));
      let updated: string;
      try {
        const correction = schema.parse(replyJson(reply, "shots"));
        for (const [index, shot] of correction.shots.entries()) {
          if (shot.shot !== spans[index]!.shot || new Set(shot.cast).size !== shot.cast.length || shot.cast.some(name => !known.has(name)) || castNames(spans[index]!).some(name => known.has(name) && !shot.cast.includes(name))) throw new Error("Cast correction changed shot IDs, removed a valid character, or used invalid character IDs");
        }
        updated = replaceShotCells(checked.shots, shotList, "cast", correction.shots.map(shot => shot.cast.join(", ")));
        if (checkScript(updated, production.input.seconds).issues.length) throw new Error("Cast correction violates the shot-list requirements");
      } catch (error) {
        castFeedback = error instanceof Error ? error.message : String(error);
        continue;
      }
      await writeProductionText(cwd, `${productionDirectory(production.id)}/shotListBeforeCastRepair${repairs.length}.md`, shotList);
      await writeProductionText(cwd, production.shotList!.path, updated);
      production.shotList!.issues = checkScript(updated, production.input.seconds).issues;
      await saveProduction(cwd, production);
      shotList = updated;
      castFeedback = "";
      contractProblem = "";
      previousReply = "";
      continue;
    }
    const missing = missingSpeakerLabels(shotList);
    if (missing.length) {
      const problem = [`Shots ${missing.map(span => span.shot).join(", ")}: dialogue needs an explicit speaker in the source shot list.`, dialogueFeedback].filter(Boolean).join("\n");
      const reply = await repair("shotList", problem, `Add speaker labels only to the Dialogue cells of these shots, in order: ${JSON.stringify(missing.map(span => span.shot))}. Return JSON {"shots":[{"shot":1,"dialogue":"Name: original words"}]}. Determine each speaker from the screenplay. Use only these character IDs: ${JSON.stringify([...known])}. Preserve every original word, quote, parenthetical performance note and separator; retain existing speaker labels. Do not alter any other field.\nProblems:\n${problem}\nScreenplay:\n${script}\nShot list:\n${shotList}`, speakerLabelsJsonSchema);
      let updated: string;
      try { updated = applySpeakerLabels(reply, shotList, known); }
      catch (error) { dialogueFeedback = error instanceof Error ? error.message : String(error); continue; }
      await writeProductionText(cwd, `${productionDirectory(production.id)}/shotListBeforeSpeakerRepair${repairs.length}.md`, shotList);
      await writeProductionText(cwd, production.shotList!.path, updated);
      production.shotList!.issues = checkScript(updated, production.input.seconds).issues;
      await saveProduction(cwd, production);
      shotList = updated;
      dialogueFeedback = "";
      contractProblem = "";
      previousReply = "";
      continue;
    }
    const prompt = planPrompt(script, shotList, production.assets);
    const reply = contractProblem
      ? await repair("contract", contractProblem, `${prompt}\nPrevious contract:\n${previousReply}\nValidation failure:\n${contractProblem}\nCorrect the contract to match the authoritative shot list and assets. Do not change the story, speakers or words.`, planJsonSchema)
      : await complete(shotListWriter, prompt, signal, { schema: planJsonSchema });
    await writeProductionText(cwd, `${productionDirectory(production.id)}/contractDraft${crypto.randomUUID().replaceAll("-", "")}.txt`, reply);
    try { return readPlan(reply, script, shotList, production.assets!); }
    catch (error) {
      contractProblem = error instanceof Error ? error.message : String(error);
      previousReply = reply;
    }
  }
}

/** The shot list prompt with the script inline; the characters with photos keep their names. */
function shotListPrompt(script: string, names: string[], input: ProductionInput) {
  const language = languageOf(input.outline);
  return [
    `Write in ${language} only.`,
    ...english(shotListInstructions("The script below", names)),
    `The film lasts ${input.seconds} seconds: the time ranges must end at ${input.seconds} s. Write every cell in ${language}.`,
    "In State, name each person's outfit by the short name the script's character section gives it.",
    "Preserve the creator's explicit camera-take and shot-count requirements, even when the screenplay omits them.",
    explicitShotRule,
    "Creator's request:",
    input.outline,
    "",
    "Script:",
    script,
  ].join("\n");
}

// The explicit video model renders clips of at most fifteen seconds, so the shot list keeps such shots that short.
const explicitShotRule = `A shot that shows a sex act or exposed genitals lasts at most ${maxWanRemixSeconds} seconds: split a longer act into several such shots, each with one action of its own.`;
const pacingSchema = z.strictObject({ shots: z.array(z.strictObject({ shot: z.number().int().positive(), problem: z.string().trim().min(1).max(1000) })).max(100) });

/**
 * Asks the text model which shots cannot be played as written: an action too long for its time, several actions in one
 * take, or a shot size or camera that cannot show its action. A model's judgement, so code only passes its findings on.
 */
async function reviewPacing(script: string, shotList: string, signal: AbortSignal) {
  const prompt = [
    "You review a shot list for an AI video film before anything is drawn or rendered. Each row is one continuous take that a video model renders from its Action cell alone.",
    `Find every shot whose people cannot play its whole Action at a natural pace within the shot's time (${beatPacing}), that stacks several actions into one take, or whose Shot size or Camera cannot show its action, such as a walk across a room in a close-up or a sex act framed away from the act.`,
    `Find too every shot that breaks this rule: ${explicitShotRule}`,
    "For each such shot say what is wrong and how to fix it: give an action its own shot, take time from a shot that needs less, or drop a beat the story can do without. The film's total length must stay the same. Leave out shots that work.",
    'Reply with JSON only: {"shots": [{"shot": 1, "problem": "..."}]}, with an empty list when every shot works.',
    "",
    "Script:", script, "", "Shot list:", shotList,
  ].join("\n");
  const { shots } = pacingSchema.parse(replyJson(await complete(shotListWriter, prompt, signal, { schema: z.toJSONSchema(pacingSchema) }), "shots"));
  return shots.map(item => `Shot ${item.shot}: ${item.problem}`);
}

/** Stops for a person: a review, or anything else they must decide; `message` is a code the page words. */
async function wait(cwd: string, production: Production, message: string, review?: Production["review"], detail?: string) {
  Object.assign(production, { status: production.input.mode === "simple" ? "failed" : "waiting", message, review, detail });
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

/**
 * Runs `work` and keeps how long it took among the production's timings, failed or not; a failed step's timing is
 * saved before its error goes on, as the run that fails reads the production afresh.
 */
async function timed<T>(cwd: string, production: Production, step: string, work: () => Promise<T>) {
  const start = new Date().toISOString();
  const started = performance.now();
  const timing: NonNullable<Production["timings"]>[number] = { step, start, seconds: 0 };
  (production.timings ??= []).push(timing);
  await saveProduction(cwd, production);
  const record = () => Object.assign(timing, { end: new Date().toISOString(), seconds: Math.round((performance.now() - started) / 100) / 10 });
  let result: T;
  try {
    result = await work();
  } catch (error) {
    record();
    if (!(error instanceof DialogueTimingError) && !(error instanceof Error && error.name === "AbortError")) production.failure ??= { step, message: error instanceof Error ? error.message : String(error), at: timing.end! };
    // Only the timing is lost when this save fails too; the step's own error is the one passed on.
    await saveProduction(cwd, production).catch(() => {});
    throw error;
  }
  record();
  await saveProduction(cwd, production);
  return result;
}

function resetShotInputs(production: Production, shots: number[], resetVisuals = true) {
  for (const shot of production.shots ?? []) if (resetVisuals && shots.includes(shot.shot)) {
    delete shot.startFrame;
  }
  production.videos = production.videos?.map(item => shots.includes(item.shot) ? { shot: item.shot } : item);
  for (const field of ["roughCut", "film", "report"] as const) delete production[field];
}

async function repairDialogueTiming(cwd: string, production: Production, signal: AbortSignal) {
  const [script, shotList] = await Promise.all([readProductionText(cwd, production.script!), readProductionText(cwd, production.shotList!)]);
  const prompt = `Reallocate this film's shot durations and local dialogue starts using the measured recordings. Preserve every shot, action, speaker, words and the exact ${production.input.seconds}-second total. Do not speed up, trim or replace audio. Leave enough time for each visual action and natural speech. Return {"shots":[{"shot":1,"seconds":2,"starts":[]}]} in shot order, where starts contains one local start per recorded line.\nScript:\n${script}\nShot list:\n${shotList}\nMeasured recordings:\n${JSON.stringify(production.dub!.shots.map(shot => ({ shot: shot.shot, seconds: shot.seconds, lines: shot.lines.map(line => ({ speaker: line.speaker, words: line.words, start: line.start, seconds: line.seconds })) })))}`;
  let feedback = "";
  let updated: string | undefined;
  while (!updated && (production.dialogueTimingRepairs ?? 0) < 2) {
    production.dialogueTimingRepairs = (production.dialogueTimingRepairs ?? 0) + 1;
    await saveProduction(cwd, production);
    const reply = await complete(shotListWriter, `${prompt}${feedback}`, signal, { schema: z.toJSONSchema(z.strictObject({ shots: dialogueTimingSchema })) });
    try {
      updated = applyDialogueTiming(production, script, shotList, replyJson(reply, "shots").shots);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Error)) throw error;
      feedback = `\nYour previous proposal was invalid: ${error.message}. Correct the timing without changing the story or total length.`;
    }
  }
  // The text model sometimes gets the arithmetic wrong twice; a timing that only grows shots to hold their recordings
  // is computed instead, and the film fails only when the recordings cannot fit at all.
  const fitted = updated ? undefined : fitDialogueTiming(production);
  if (fitted) updated = applyDialogueTiming(production, script, shotList, fitted);
  if (updated) {
    await writeProductionText(cwd, production.shotList!.path, updated);
    resetShotInputs(production, production.shots!.map(shot => shot.shot));
    production.shots = planShots(updated, production.assets!, production.plan!);
    delete production.previs;
    delete production.execution;
    delete production.clips;

    delete production.failure;
    await saveProduction(cwd, production);
    return;
  }
  throw new Error("Dialogue timing could not fit the requested film duration after two repairs");
}

/** Runs the next step and returns whether there is more to do now. */
async function step(cwd: string, id: string, signal: AbortSignal): Promise<boolean> {
  const production = await readProduction(cwd, id);
  const preparation = runtimeOwners.get(runnerKey(cwd, id))?.preparation;
  if (preparation) production.runtime = preparation.state;
  if (production.status !== "running") return false;
  const needs = (gate: ProductionGate) => production.input.gates.includes(gate) && !production.approved.includes(gate);

  if (production.input.mode === "simple" && !production.direction) {
    const schema = z.strictObject({ seconds: z.number().int().min(5).max(600), ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]) });
    production.direction = await timed(cwd, production, "direction", async () => schema.parse(replyJson(await complete(
      "You direct a fully automatic film production. Return only the requested JSON. Do not ask the user questions.",
      `Choose the film duration and aspect ratio from this story. Honor an explicit duration and ratio. Otherwise choose the shortest duration that tells the whole story without rushing speech (normally 5–60 seconds), and a suitable ratio. All characters, images and voices will be designed by the AI. Story:\n${production.input.outline}`,
      signal, { schema: z.toJSONSchema(schema) },
    ), "direction")));
    Object.assign(production.input, production.direction);
    production.estimate = (await quoteProduction(production.input)).total;
    await saveProduction(cwd, production);
    return true;
  }

  if (!production.script) {
    const path = `${productionDirectory(id)}/script.md`;
    await writeProductionText(cwd, path, `${await timed(cwd, production, "script", () => complete(screenwriter, scriptPrompt(production.input), signal))}\n`);
    production.script = { path };
    if (production.conversationChanges) production.conversationChanges.applied = [...production.conversationChanges.requested];
    await saveProduction(cwd, production);
    return true;
  }
  if (production.review?.gate === "script" && production.review.notes) {
    const script = await readProductionText(cwd, production.script);
    const path = `${productionDirectory(id)}/scriptRevision${crypto.randomUUID().replaceAll("-", "")}.md`;
    await writeProductionText(cwd, path, `${await timed(cwd, production, "scriptRevision", () => complete(screenwriter, revisionPrompt(script, production.review!.notes!), signal))}\n`, true);
    await resetScriptOutputs(cwd, production);
    production.script = { path, manual: false };
    if (production.conversationChanges) production.conversationChanges.applied = [...production.conversationChanges.requested];
    production.review = undefined;
    await saveProduction(cwd, production);
    return true;
  }
  if (needs("script")) return wait(cwd, production, "reviewScript", { gate: "script" });

  // The cast follows the shot list, whose state cells name the outfits each shot needs.
  if (!production.shotList || !production.assets) {
    const script = await readProductionText(cwd, production.script);
    const listed = production.shotList ? Promise.resolve() : timed(cwd, production, "shotList", async () => {
      const names = production.input.photos.map(photo => photo.name);
      const prompt = shotListPrompt(script, names, production.input);
      let shotList = await complete(shotListWriter, prompt, signal);
      // A list failing the timing check (here also against the film's length) or the pacing review is rewritten with the
      // problems found, twice at most. ACT: pacing problems left after that only reach the log, as the review is a model's
      // judgement and the film can still be made.
      for (let round = 0; round < 3; round++) {
        const timing = english(checkScript(shotList, production.input.seconds).issues);
        const pacing = timing.length ? [] : await reviewPacing(script, shotList, signal);
        if (!timing.length && !pacing.length) break;
        if (round === 2) { console.warn("[production] Shot list pacing problems remain:", pacing); break; }
        // Where the film cannot hold every event of the script at a natural pace, beats are dropped rather than rushed.
        const cut = pacing.length ? ["Where the film is too short for every event of the script at a natural pace, leave out the least important beats; this overrides covering the whole script."] : [];
        shotList = await complete(shotListWriter, shotListFixPrompt(prompt, shotList, [...timing, ...pacing, ...cut]), signal);
      }
      const check = checkScript(shotList, production.input.seconds);
      if (check.issues.length || !check.shots.length || check.shots.some(shot => !Number.isFinite(shot.duration) || shot.duration <= 0 || (shot.start !== undefined && (!Number.isFinite(shot.start) || shot.start < 0)))) {
        throw new Error("The shot list has no usable shots; correct it before production continues");
      }
      const path = `${productionDirectory(id)}/shotList.md`;
      await writeProductionText(cwd, path, `${shotList}\n`);
      production.shotList = { path, shots: check.shots.length, issues: check.issues };
      await saveProduction(cwd, production);
    });
    const cast = production.assets ? Promise.resolve() : listed.then(() => timed(cwd, production, "cast", async () => {
      const shotList = await readProductionText(cwd, production.shotList!);
      production.assets = parseCast(await complete(shotListWriter, castPrompt(script, shotList), signal, { schema: castJsonSchema }), production.input.photos);
      await saveProduction(cwd, production);
    }));
    // Both are awaited before an error is passed on, so neither goes on writing unwatched.
    const failure = (await Promise.allSettled([listed, cast])).find(result => result.status === "rejected");
    await saveProduction(cwd, production);
    if (failure) throw failure.reason;
    return true;
  }
  const [script, shotList] = await Promise.all([readProductionText(cwd, production.script), readProductionText(cwd, production.shotList)]);
  if (!production.references) {
    production.references = await timed(cwd, production, "references", () => planReferences(production, script, shotList, (prompt, schema) => complete(shotListWriter, prompt, signal, { schema })));
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.plan) {
    if (checkScript(shotList).shots.some(shot => shot.duration > maxTakeSeconds)) throw new Error(`Shots exceed the ${maxTakeSeconds}-second limit of one take; split the shot list before production`);
    production.plan = await timed(cwd, production, "contractPlan", () => compileProductionPlan(cwd, production, script, shotList, signal));
    await saveProduction(cwd, production);
    return true;
  }
  const contract = requireCurrentPlan(production, script, shotList);
  if (!production.shots) {
    production.shots = planShots(shotList, production.assets, contract);
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.dub) {
    production.dub = planDub(shotList, production.assets, contract);
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.execution) {
    await applyAudioReferences(cwd, production, signal);
    production.execution = await timed(cwd, production, "executionPlan", () => planExecution(production, signal));
    await saveProduction(cwd, production);
    return true;
  }
  if (!production.previs || previsCastIssues(production).length || production.previs.some(item => !cameraMeasurements.safeParse(item.framed?.camera).success)) {
    const model = configuredModel(uncensoredTextModelId);
    resetShotInputs(production, production.shots.map(shot => shot.shot));
    production.previs = await timed(cwd, production, "previsPlan", () => planPrevis(cwd, production, `${script}\n\nAuthoritative opening states and dialogue times (screenLeft/screenRight refer to the image, not actor anatomy):\n${JSON.stringify(contract.shots)}`, shotList, { providerId: model.providerId, modelId: model.modelId }, signal));
    const issues = previsCastIssues(production);
    if (issues.length) throw new Error(issues.join("; "));
    await saveProduction(cwd, production);
    return true;
  }
  const castIssues = previsCastIssues(production);
  if (castIssues.length) throw new Error(castIssues.join("; "));
  const assets = [...production.assets.characters, ...production.assets.places];
  if (assets.some(item => !assetDrawn(item)) || production.assets.characters.some(item => !item.loras) || !production.clips || production.clips.length !== production.shots.length
    || production.previs.some(item => !item.video)
    || textsMissing(production) || production.videos?.some(item => !item.video)
    || (production.input.music && !production.music) || production.ambience?.some(item => !item.bed?.videoSha256)) {
    return produceClips(cwd, production, signal);
  }
  if (!production.roughCut) {
    production.roughCut = await timed(cwd, production, "roughCut", () => joinRoughCut(cwd, production, signal));
    await saveProduction(cwd, production);
    return true;
  }

  if (!production.film) {
    production.film = await timed(cwd, production, "film", () => finishFilm(cwd, production, signal));
    await saveProduction(cwd, production);
    return true;
  }
  await timed(cwd, production, "deliveryValidation", () => validateFilm(cwd, production, signal));
  if (!production.report) {
    production.report = await deliveryReport(cwd, production, signal);
  }
  Object.assign(production, { status: "done", message: "filmDone", review: undefined });
  await saveProduction(cwd, production);
  return false;
}

/** Prepares validated input snapshots and renders each shot within the same cancellation scope. */
async function produceClips(cwd: string, production: Production, signal: AbortSignal) {
  const [script, shotList] = await Promise.all([readProductionText(cwd, production.script!), readProductionText(cwd, production.shotList!)]);
  const assets = [...production.assets!.characters, ...production.assets!.places];
  // Reused people bring their trigger words, so they are taken before the LoRA plan fixes new triggers.
  await reuseDesigns(cwd, production);
  const plan = await planAssetLoras(cwd, production);
  production.videos ??= production.shots!.map(({ shot }) => ({ shot }));
  const videos = production.videos;
  const open = videos.filter(item => !item.video);
  const save = () => saveProduction(cwd, production);
  await save();
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);
  const tasks: Promise<unknown>[] = [];
  const waiting: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  const readiness = () => {
    const ready = Promise.withResolvers<void>();
    waiting.push(ready);
    void ready.promise.catch(() => {});
    return ready;
  };
  const assetReady = new Map(assets.map(item => [item, readiness()]));
  const previsReady = new Map(production.previs!.map(item => [item.shot, readiness()]));
  const dubReady = new Map(production.dub!.shots.map(item => [item.shot, readiness()]));
  const abortWaiting = () => waiting.forEach(item => item.reject(workSignal.reason));
  workSignal.addEventListener("abort", abortWaiting, { once: true });
  const track = <T>(promise: Promise<T>) => {
    tasks.push(promise);
    void promise.catch(error => controller.abort(error));
    return promise;
  };
  const rejectWaiting = (items: Iterable<ReturnType<typeof readiness>>, error: unknown) => {
    for (const item of items) item.reject(error);
    throw error;
  };
  const releaseQwen = holdQwenImage();
  const releaseText = holdColab();
  let releaseVideo = open.length ? limitSulphur(1) : () => {};
  let releaseWarm = () => {};
  let warming = false;
  let preparedForVideo = false;
  const warmVideo = () => {
    if (!preparedForVideo || warming || !open.some(item => !item.video)) return;
    warming = true;
    releaseVideo();
    // ACT: one video renderer: the second A100 checks keyframes and clips, and rendering there as well would unload the
    // vision model for every clip. Renders would go twice as fast on two A100s with a fourth machine for the checks.
    const workers = production.execution!.machines.renderWorkers;
    releaseVideo = holdSulphur(workers);
    releaseWarm = warmSulphur(production.input.quality, production.input.ratio, workers, 20 * 60_000, workSignal);
  };
  try {
    workSignal.throwIfAborted();
    const drawing = track(timed(cwd, production, "designs", () => drawAssets(cwd, production, production.input.ratio, workSignal, save, item => assetReady.get(item)!.resolve(), (brief, ratio) => writeImagePrompt(brief, ratio, workSignal))).catch(error => rejectWaiting(assetReady.values(), error)));
    const training = new Map(assets.map(item => [item, track((async () => {
      await assetReady.get(item)!.promise;
      const job = plan.jobs.find(job => job.item === item);
      if (job) await timed(cwd, production, "loras", () => trainAssetLora(cwd, job, workSignal, save));
    })())]));
    const blocked = track(timed(cwd, production, "previsRender", () => renderPrevis(cwd, production, shotList, workSignal, save, shot => previsReady.get(shot)!.resolve())).catch(error => rejectWaiting(previsReady.values(), error)));
    const dubbed = track(timed(cwd, production, "dub", () => recordDub(cwd, production, workSignal, save, shot => dubReady.get(shot)!.resolve())).catch(error => rejectWaiting(dubReady.values(), error)));
    const materials = new Map(production.previs!.map(previs => {
      const shot = production.shots!.find(item => item.shot === previs.shot)!;
      const references = shotReferences(shot, production.assets!, previs.framed);
      // A shot that does not continue the clip before it gets a keyframe, once its previs and the designs of its people
      // and place are drawn; a clip waits for that and for the LoRAs of its people.
      const keyframe = track((async () => {
        await Promise.all([previsReady.get(shot.shot)!.promise, assetReady.get(references.place.place)!.promise, ...references.people.map(({ person }) => assetReady.get(person)!.promise)]);
        if (!videos.find(item => item.shot === shot.shot)?.video && continuedFrom(production, shot.shot) === undefined) await timed(cwd, production, "keyframes", () => drawKeyframe(cwd, production, shot.shot, script, shotList, prompt => complete(keyframeWriter, prompt, workSignal), (prompt, images) => dubbed.then(() => see(checker, prompt, images, workSignal)), workSignal, save));
      })());
      const ready = track(Promise.all([keyframe, ...references.people.map(({ person }) => training.get(person)!)]));
      return [shot.shot, { ready, keyframe }] as const;
    }));
    // Qwen-Image stays loaded until the last keyframe is drawn.
    const drawn = track(Promise.all([drawing, ...[...materials.values()].map(item => item.keyframe)]).finally(releaseQwen));
    const prepared = track(Promise.all([drawn, blocked, ...training.values()]).then(() => {
      workSignal.throwIfAborted();
    }));
    track(prepared.then(() => { preparedForVideo = true; warmVideo(); }));
    const prompts = new Map(videos.map(item => [item.shot, track((async () => {
      const shot = production.dub!.shots.find(shot => shot.shot === item.shot)!;
      // A long take's parts follow the recorded lines' times, so its prompts wait for the dub; every prompt opens on
      // its keyframe's description.
      if (clipSeconds(shot.seconds) > maxClipSeconds) await dubReady.get(item.shot)!.promise;
      await materials.get(item.shot)!.keyframe;
      await timed(cwd, production, "texts", () => writeClipPrompts(production, script, shotList, prompt => complete(videoWriter, prompt, workSignal), save, [item.shot]));
    })())]));
    track(prepareSound(cwd, production, dubbed, prepared, workSignal));
    const rendering = new Map<number, Promise<void>>();
    for (const item of open) {
      rendering.set(item.shot, track((async () => {
        await dubbed;
        await materials.get(item.shot)!.ready;
        await prompts.get(item.shot)!;
        // A shot that keeps the previous one's setup starts from that clip's last frame, so it waits for it.
        const previous = continuedFrom(production, item.shot);
        if (previous !== undefined) {
          await rendering.get(previous);
          await takeStartFrame(cwd, production, item.shot, workSignal, save);
        }
        // Each render is checked by the vision model; one that fails is written again knowing what went wrong and
        // rendered again, never the same prompt with a new seed, and after the last correction the render with the
        // fewest major problems is kept.
        for (;;) {
          workSignal.throwIfAborted();
          if (!item.prompt) await timed(cwd, production, "texts", () => writeClipPrompts(production, script, shotList, prompt => complete(videoWriter, prompt, workSignal), save, [item.shot]));
          await prepareClipInputs(cwd, production, item, workSignal, save);
          warmVideo();
          if (!item.video) await timed(cwd, production, "clips", () => renderClips(cwd, production, [item], production.input.quality, "clips", workSignal, save));
          if (item.check) break;
          item.check = await timed(cwd, production, "clipChecks", () => checkClip(cwd, production, item, (prompt, images) => see(checker, prompt, images, workSignal), workSignal));
          if (item.check.passed || (item.attempts?.length ?? 0) >= clipCorrections) {
            const { attempts = [], ...current } = item;
            const best = [...attempts, current].reduce((kept, other) => majorProblems(other.check!).length < majorProblems(kept.check!).length ? other : kept);
            if (best !== current) Object.assign(item, { prompt: undefined, parts: undefined, ...best, attempts });
            if (!item.check!.passed) console.warn(`[production] Shot ${item.shot}: clip kept with problems`, majorProblems(item.check!));
            await save();
            break;
          }
          const { attempts = [], ...failed } = item;
          item.attempts = [...attempts, failed];
          item.feedback = majorProblems(item.check);
          for (const field of ["prompt", "parts", "video", "remote", "inputSnapshot", "check"] as const) delete item[field];
          await save();
        }
      })()));
    }
    track((async () => {
      const results = await Promise.allSettled(rendering.values());
      releaseWarm();
      releaseVideo();
      releaseText();
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      if (!production.roughCut) {
        production.roughCut = await timed(cwd, production, "roughCut", () => joinRoughCut(cwd, production, workSignal));
        await save();
      }
    })());
    const results = await Promise.allSettled(tasks);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw controller.signal.reason ?? failure.reason;
    await save();
    return true;
  } finally {
    controller.abort();
    await Promise.allSettled(tasks);
    releaseText();
    releaseQwen();
    releaseWarm();
    releaseVideo();
    workSignal.removeEventListener("abort", abortWaiting);
  }
}

const videoWriter = "You write prompts for the Sulphur 2 (LTX-2.3) video model.";
const keyframeWriter = "You describe the opening frame of a film shot for an image model.";
const composer = "You describe film scores for a music generation model.";
const soundEditor = "You describe continuous environmental sounds for independent ambience generation.";
/** Whether a clip prompt, music style or environment sound description is missing. */
const textsMissing = (production: Production) => !production.videos || production.videos.some(item => !item.prompt) || (production.input.music && !production.musicStyle) || !production.ambience;

/**
 * Prepares the score after dubbing fixes its duration; independent ambience waits until image work is complete.
 * Both run alongside clip rendering and neither waits for the rough cut.
 */
async function prepareSound(cwd: string, production: Production, dubbed: Promise<unknown>, visuals: Promise<unknown>, signal: AbortSignal) {
  const script = await readProductionText(cwd, production.script!);
  const save = () => saveProduction(cwd, production);
  const music = (async () => {
    await dubbed;
    if (production.input.music && !production.musicStyle) {
      production.musicStyle = await complete(composer, musicPrompt(script, production.clips!.reduce((sum, item) => sum + item.clip, 0)), signal);
      await save();
    }
    if (production.input.music && !production.music) {
      production.music = await timed(cwd, production, "music", () => scoreFilm(cwd, production, production.musicStyle!, production.clips!.reduce((sum, item) => sum + item.clip, 0), signal));
      await save();
    }
  })();
  const ambience = (async () => {
    if (!production.ambience) {
      // Scene ambience comes from the outline; a locked dialogue track's silence does not describe the room.
      const usedPlaces = new Set(production.plan!.shots.map(shot => shot.place));
      const places = production.references?.some(item => item.use === "ambience") ? [] : production.assets!.places.filter(place => usedPlaces.has(place.name)).map(({ name, look }) => ({ name, look }));
      const schema = z.strictObject(Object.fromEntries(places.map(place => [place.name, z.string().trim().max(1000)])));
      const queries = places.length ? schema.parse(replyJson(await complete(soundEditor, ambiencePrompt(places, production.input.outline), signal, { schema: z.toJSONSchema(schema) }), "queries")) : {};
      production.ambience = places.flatMap(place => queries[place.name]?.trim() ? [{ place: place.name, query: queries[place.name]!.trim() }] : []);
      await save();
    }
    if (production.ambience?.some(item => !item.bed?.videoSha256)) {
      await visuals;
      await timed(cwd, production, "ambience", () => generateAmbience(cwd, production, signal, save));
    }
  })();
  const results = await Promise.allSettled([music, ambience]);
  const failure = results.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
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
    t`Colab compute units: ${spent} spent (estimate ${production.estimate}).`,
    t`Dialogue: Fish Audio Drama 3 through its API, with newly designed character voices.`,
    "Video content review: not performed. Delivery validation checks file encoding, dimensions, duration and audio-track presence only.",
    ...production.music ? [t`Music: Suno V6, billed by the sunoapi.org account.`] : [],
    ...production.ambience?.flatMap(item => item.bed ? [`Ambience of ${item.place}: Sulphur 2; source video ${item.bed.video}; prompt ${item.bed.prompt}; SHA-256 ${item.bed.videoSha256}.`] : []) ?? [],
    "",
    "## Execution plan",
    "",
    `- Decisions: ${production.execution!.decision.model}.`,
    `- Planned physical machines: ${executionAllocation(production).lanes.length}; ${production.execution!.machines.reason}`,
    `- Video render workers: ${production.execution!.machines.renderWorkers}.`,
    ...production.execution!.characters.map(item => `- Character ${item.name}: ${item.views} reference views. ${item.reason}`),
    ...production.execution!.places.map(item => `- Environment ${item.name}: ${item.views} reference views. ${item.reason}`),
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
    `## ${t`Timings`}`,
    "",
    t`${((Date.now() - Date.parse(production.createdAt)) / 60_000).toFixed(1)} minutes from start to report.`,
    "",
    `| ${t`Step`} | ${t`Started`} | ${t`Minutes`} |`,
    "| --- | --- | --- |",
    ...(production.timings ?? []).map(item => `| ${item.step} | ${new Date(item.start).toLocaleTimeString()} | ${(item.seconds / 60).toFixed(1)} |`),
    "",
    `## ${t`Models`}`,
    "",
    `- ${t`Script, shot list and prompts: ${uncensoredTextModelId} on Colab`}`,
    "- Written and image quality reviews: not performed.",
    "- Speech and pronunciation reviews: not performed.",
    `- ${t`Designs: Qwen-Image 2.1 on Colab`}`,
    `- ${t`Video: Sulphur 2 (LTX-2.3) on Colab with the LoRAs of each shot's people, starting from the previous clip's last frame only when a shot keeps its camera setup, following its previs depth video when someone walks or the camera moves, lip-synced to the dubbed lines`}`,
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
  const runtime: RuntimeOwner = runtimeOwners.get(key) ?? { release: holdColabPool() };
  runtimeOwners.set(key, runtime);
  const finished = (async () => {
    const releaseText = holdColab();
    try {
      await setRegistered(cwd, id, true);
      const initial = await readProduction(cwd, id);
      initial.meterAtStart ??= meteredColabUnits();
      await saveProduction(cwd, initial);
      runtime.started = true;
      await requireJevKey();
      const planning = await readProduction(cwd, id);
      if (planning.assets && planning.assets.recipe !== "b3") throw new Error(translateMessage("這個舊任務的素材無法確認為 B3，請新建製作；原始檔案仍保留。"));
      // Pending revisions invalidate dispatch before startup can inspect the old execution plan.
      if (planning.review?.gate === "script" && planning.review.notes) delete planning.execution;
      planning.startupPlan = await timed(cwd, planning, "startupPlan", () => planStartup(planning));
      if (planning.execution && planning.execution.source !== executionSource(planning)) {
        delete planning.execution;
        resetShotInputs(planning, planning.plan!.shots.map(shot => shot.shot));
        delete planning.previs;

      }
      await saveProduction(cwd, planning);
      let more = true;
      while (more) {
        controller.signal.throwIfAborted();
        await applyConversationChanges(cwd, id, controller.signal);
        const current = await readProduction(cwd, id);
        const allocation = current.execution ? executionAllocation(current) : startupAllocation(current.startupPlan!);
        allocation.ready = async name => {
          const ready = runtime.preparation?.roles.get(name);
          if (!ready) throw new Error(`Model ${name} is not part of this production's preparation`);
          await ready;
        };
        try {
          more = await withColabAllocation(allocation, async () => {
            await prepareRuntime(cwd, current, controller.signal);
            return step(cwd, id, controller.signal);
          });
        } catch (error) {
          if (error instanceof DialogueTimingError) {
            const failed = await readProduction(cwd, id);
            await timed(cwd, failed, "dialogueTimingRepair", () => repairDialogueTiming(cwd, failed, controller.signal));
            more = true;
            continue;
          }
          throw error;
        }
        if (!more) {
          await conversationReplies.get(key);
          controller.signal.throwIfAborted();
          more = await applyConversationChanges(cwd, id, controller.signal);
        }
      }
    } catch (error) {
      controller.abort(error);
      if (!controller.signal.aborted || controller.signal.reason instanceof Error && controller.signal.reason.name !== "AbortError") {
        const production = await readProduction(cwd, id);
        Object.assign(production, { status: "failed", message: error instanceof Error ? error.message : String(error) });
        await saveProduction(cwd, production);
      }
    } finally {
      if (controller.signal.aborted && runtime.preparation) await Promise.allSettled([runtime.preparation.allReady]);
      releaseText();
      try {
        const latest = await readProduction(cwd, id);
        if (latest.status === "done" || latest.status === "failed" || latest.input.mode === "simple" || controller.signal.aborted || !runtime.started) {
          latest.cleanup = { status: "running", start: new Date().toISOString() };
          const began = performance.now();
          await saveProduction(cwd, latest).finally(async () => {
            try {
              await releaseRuntime(key, latest.status === "done");
              latest.cleanup!.status = "done";
            } catch (error) {
              latest.cleanup!.status = "failed";
              latest.cleanup!.error = error instanceof Error ? error.message : String(error);
              throw error;
            } finally {
              latest.cleanup!.end = new Date().toISOString();
              latest.cleanup!.seconds = (performance.now() - began) / 1000;
              await saveProduction(cwd, latest);
            }
          });
        }
      } finally {
        runners.delete(key);
        await setRegistered(cwd, id, false).catch(() => {});
      }
    }
  })().catch(error => console.error("[production] Runner failed:", error));
  runners.set(key, { controller, finished });
}

/** Estimates new production work; another character's matching name is not proof of reusable training identity. */
export async function quoteProduction(input: Pick<ProductionInput, "seconds" | "quality" | "photos">) {
  return estimateProduction(input, 0, await costRatio());
}

export async function createProduction(cwd: string, id: string, input: ProductionInput) {
  const now = new Date().toISOString();
  input = { ...input, mode: input.mode ?? "expert", modelRecipe: "sulphur2", ...(input.mode === "simple" ? { gates: [], photos: [] } : {}) };
  await saveProduction(cwd, {
    toonflowProduction: 1, id, createdAt: now, updatedAt: now, input, originalOutline: input.outline, status: "running", approved: [],
    estimate: (await quoteProduction(input)).total,
  }, true);
  runProduction(cwd, id);
}

/**
 * Answers the review a production waits on: approves it, or sends change requests that the engine carries out before
 * asking again. A script a person edited in place is saved first and kept as written.
 */
export async function reviewProduction(cwd: string, id: string, answer: { notes?: string; script?: string }) {
  const production = await readProduction(cwd, id);
  if (production.input.mode === "simple") throw Object.assign(new Error("Simple productions do not accept manual changes"), { status: 409 });
  if (production.status !== "waiting" || !production.review) throw Object.assign(new Error("This production is not waiting for a review"), { status: 409 });
  if (answer.script !== undefined && production.script) {
    await writeProductionText(cwd, production.script.path, answer.script);
    await resetScriptOutputs(cwd, production);
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

/** Continues a production stopped by an error or for a person. */
export async function resumeProduction(cwd: string, id: string) {
  if (runners.has(runnerKey(cwd, id))) throw Object.assign(new Error("Production is still running or cleaning up"), { status: 409 });
  const production = await readProduction(cwd, id);
  if (production.input.mode === "simple") throw Object.assign(new Error("Simple productions do not accept manual continuation"), { status: 409 });
  if (production.status === "done" || production.status === "waiting" && production.review && !production.runtime?.failure) throw Object.assign(new Error("This production has nothing to continue"), { status: 409 });
  await continueProduction(cwd, production);
}

async function continueProduction(cwd: string, production: Production) {
  const id = production.id;
  const key = runnerKey(cwd, id);
  if (runners.has(key) || continuations.has(key)) throw Object.assign(new Error(translateMessage("製作仍在執行或收尾，請稍候。")), { status: 409 });
  continuations.add(key);
  try {
    if (production.runtime?.failure) {
      const owner = runtimeOwners.get(runnerKey(cwd, id));
      owner?.preparation?.cancel();
      if (owner?.preparation) await Promise.allSettled([owner.preparation.allReady]);
      if (owner) owner.preparation = undefined;
      delete production.runtime.failure;
      delete production.runtime.readyAt;
      await writeProductionText(cwd, `${productionDirectory(id)}/runtimePreparation.json`, JSON.stringify(production.runtime));
    }
    delete production.cleanup;
    delete production.failure;
    delete production.dialogueTimingRepairs;
    Object.assign(production, { status: "running", message: undefined, detail: undefined });
    await saveProduction(cwd, production);
    runProduction(cwd, id);
  } finally { continuations.delete(key); }
}

export async function resolveSimpleProduction(cwd: string, id: string, action: "retry" | "clarify", message?: string) {
  if (runners.has(runnerKey(cwd, id))) throw Object.assign(new Error("製作仍在執行或收尾，請稍候。"), { status: 409 });
  const production = await readProduction(cwd, id);
  if (production.input.mode !== "simple" || production.status !== "failed") throw Object.assign(new Error("這支影片目前不需要調整。"), { status: 409 });
  if (action === "retry" && !productionGuidance(production)?.canRetry) throw Object.assign(new Error("目前需要先補充調整內容，AI 才能重新處理未通過的素材。"), { status: 409 });
  if (action === "clarify") {
    if (!message?.trim()) throw Object.assign(new Error("請補充你希望保留或調整的內容。"), { status: 400 });
    if (production.input.outline.length + message.trim().length + 30 > 20000) throw Object.assign(new Error("補充後的故事超過長度限制，請縮短調整內容。"), { status: 400 });
    production.originalOutline ??= production.input.outline;
    production.input.outline += `\n\nCreator clarification:\n${message.trim()}`;
    delete production.direction;
    if (production.script) production.review = { gate: "script", notes: message.trim() };
  }
  (production.recoveries ??= []).push({ at: new Date().toISOString(), action, message: message?.trim(), fromStep: production.timings?.at(-1)?.step, cleanup: production.cleanup });
  await continueProduction(cwd, production);
}

/** Stops a running production after aborting its current step; paid work already running on Colab is stopped too. */
export async function stopProduction(cwd: string, id: string) {
  const key = runnerKey(cwd, id);
  const runner = runners.get(key);
  runner?.controller.abort();
  await runner?.finished;
  await releaseRuntime(key);
  const production = await readProduction(cwd, id);
  if (production.status === "done") return;
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
