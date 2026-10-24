import { dirname, join } from "node:path";
import { mkdir, readFile, realpath, writeAtomic } from "@toonflow/file";
import type { MessageDescriptor } from "@toonflow/i18n";
import conf from "@/utils/conf";
import { translateMessage } from "@/lib/i18n";
import type { ProductionAmbience } from "./ambience";
import type { ProductionDub } from "./dub";
import type { ProductionPrevis } from "./previs";
import type { ProductionClip } from "./video";
import type { ProductionShot } from "./shots";
import type { ProductionPlan } from "./plan";
import type { ExecutionPlan, StartupPlan } from "./execution";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { z } from "zod";
import { modelPreparationTimingSchema } from "@/utils/media/timings";

export const productionRuntimeSchema = z.object({
  timings: z.array(z.object({ step: z.string(), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }), seconds: z.number().finite().nonnegative() })).optional(),
  readyAt: z.string().datetime({ offset: true }).optional(),
  failure: z.string().min(1).optional(),
  machines: z.array(z.object({ lane: z.number().int().min(0).max(3), session: z.string().regex(/^toonflow-[0-9a-f]{8}$/), gpu: z.string(), ramTotal: z.number().finite().positive(), ramAvailable: z.number().finite().nonnegative(), diskTotal: z.number().finite().positive(), diskFree: z.number().finite().nonnegative() })),
  models: z.array(modelPreparationTimingSchema),
});

export const productionGates = ["script"] as const;
export type ProductionGate = typeof productionGates[number];
export const productionQualities = ["480p", "720p", "1080p"] as const;
export const productionRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const conversationChangesSchema = z.strictObject({ requested: z.array(z.string().uuid()), applied: z.array(z.string().uuid()) }).refine(value => new Set(value.requested).size === value.requested.length && new Set(value.applied).size === value.applied.length && value.applied.every(id => value.requested.includes(id)), "Invalid production conversation checkpoint");

/** What the user starts a production with; only the outline and the length are required. */
export type ProductionInput = {
  outline: string;
  seconds: number;
  ratio: typeof productionRatios[number];
  quality: typeof productionQualities[number];
  gates: ProductionGate[];
  /** Photos of characters the user already has, by the name the outline uses. */
  photos: { name: string; path: string }[];
  /** Burns the dialogue into the film as subtitles. */
  subtitles: boolean;
  /** Scores the film with Suno music, which bills the sunoapi.org account rather than Colab units. */
  music: boolean;
  mode?: "simple" | "expert";
  fromConversation?: boolean;
  modelRecipe?: "sulphur2";
  references?: import("./references").ReferenceAttachment[];
  referenceNotes?: string[];
};

/** A text the production writes, which a person can rewrite; `manual` texts are never rewritten by the engine. */
export type ProductionText = { path: string; manual?: boolean };

/**
 * The state of one production, saved after every step as `productions/<id>/production.json` in the workspace so the
 * engine continues where it stopped after a restart. The id is the canvas node that started it.
 */
export type Production = {
  toonflowProduction: 1;
  id: string;
  createdAt: string;
  input: ProductionInput;
  originalOutline?: string;
  conversationChanges?: z.infer<typeof conversationChangesSchema>;
  /** `waiting` stops for a person (a review gate), `failed` for an error a retry may clear. */
  status: "running" | "waiting" | "failed" | "done";
  /** Why it stopped, as a code the page words; `detail` carries the underlying error. */
  message?: string;
  detail?: string;
  failure?: { step: string; message: string; at: string };
  dialogueTimingRepairs?: number;
  contractRepairs?: { at: string; source: "shotList" | "contract"; problem: string; reply?: string }[];
  /** The review the production waits on, with the change requests a person sent back. */
  review?: { gate: ProductionGate; notes?: string };
  approved: ProductionGate[];
  /** Compute units: the balance and the metered units when the production started, and the estimate shown then. */
  balanceAtStart?: number;
  meterAtStart?: number;
  estimate: number;
  direction?: { seconds: number; ratio: ProductionInput["ratio"] };
  cleanup?: { status: "running" | "done" | "failed"; start: string; end?: string; seconds?: number; error?: string };
  recoveries?: { at: string; action: "retry" | "clarify" | "repair" | "accept"; message?: string; fromStep?: string; cleanup?: Production["cleanup"]; review?: string }[];
  script?: ProductionText;
  /** The shot list and the problems its timing check still finds after one fix, as message descriptors. */
  shotList?: ProductionText & { shots: number; issues: MessageDescriptor[] };
  /**
   * The cast and places of the script with their look; `base` is the photo or generated design every other view is
   * drawn from, `views` the reference images clips and LoRAs use.
   */
  assets?: { recipe: "b3"; characters: ProductionAsset[]; places: ProductionAsset[] };
  previousAssets?: Production["assets"];
  references?: import("./references").ProductionReference[];
  plan?: ProductionPlan;
  execution?: ExecutionPlan;
  startupPlan?: StartupPlan;
  shots?: ProductionShot[];
  dub?: ProductionDub;
  previousDub?: ProductionDub;
  previs?: ProductionPrevis;
  videos?: ProductionClip[];
  /** Per-step timing checkpoints; an absent end marks work whose completion was not recorded. */
  timings?: { step: string; start: string; end?: string; seconds: number }[];
  runtime?: z.infer<typeof productionRuntimeSchema>;
  roughCut?: string;
  /** Each shot's clip length in whole seconds, set by its dubbed lines. */
  clips?: { shot: number; clip: number }[];
  /** The style prompt of the Suno score, written with the other texts, and the score under the whole film, when the production asked for music. */
  musicStyle?: string;
  music?: string;
  /** Each place's independent sound description and generated bed, mixed beneath the original dialogue. */
  ambience?: ProductionAmbience[];
  /** The finished film and its delivery report. */
  film?: string;
  report?: string;
  updatedAt: string;
};

/**
 * A person or place: `base` is the photo or design every view is drawn from, `views` its reference images (for a
 * person face close-ups) and `outfits` a person's clothes in the story, each with its full-body views. A photo fixes
 * who someone is, never what they wear: the script decides that. `loras` are its trained LoRAs, empty when it appears in
 * too few shots to be worth one; `triggers` their trigger words, fixed when the LoRAs are planned, so texts can name
 * them while they train.
 */
export type ProductionAsset = {
  name: string; look: string; photo?: string; photoSha256?: string; base?: string; views?: string[];
  generationPrompt?: { text: string };
  outfits?: { name: string; look: string; views?: string[] }[];
  loras?: { family: "ltx" | "qwen"; path: string; trigger: string }[];
  triggers?: Partial<Record<"ltx" | "qwen", string>>;
};

export const assetDrawn = (item: ProductionAsset) => !!item.views?.length && (item.outfits ?? []).every(outfit => !!outfit.views?.length);

export const productionDirectory = (id: string) => `productions/${id}`;

export function productionGuidance(production: Production) {
  if (production.status !== "failed" && !(production.status === "waiting" && !production.review)) return undefined;
  if (/Dialogue recording did not meet|Recorded dialogue needs revised|Dialogue timing could not fit/.test(production.message ?? "")) return {
    summary: translateMessage("配音長度與鏡頭時間無法配合，製作已中斷；已完成的錄音與素材仍保留。"),
    question: translateMessage("接續時會先協調配音與分鏡時間，再製作影片。"),
    suggestions: [] as string[], retryable: true, canRetry: true,
  };
  if (production.review?.gate === "script" && production.review.notes) return {
    summary: translateMessage("已收到你的補充，但製作在套用前中斷；補充內容仍完整保留。"),
    question: translateMessage("讓 AI 接續套用既有補充即可，不需要再次提交相同內容。"),
    suggestions: [] as string[], retryable: true, canRetry: true,
  };
  return {
    summary: translateMessage("製作流程發生錯誤，已完成的檔案與補充內容仍會保留。"),
    question: translateMessage("可以接續處理未完成的工作；只有想更改故事時，才需要補充要求。"),
    suggestions: [] as string[],
    retryable: true,
    canRetry: true,
  };
}

export function productionProgress(production: Production, active: boolean) {
  const assets = production.assets && [...production.assets.characters, ...production.assets.places];
  const totalShots = production.shotList?.shots ?? 0;
  const completedShots = new Set(production.videos?.filter(shot => shot.video).map(shot => shot.shot)).size;
  const pending = new Set(production.timings?.filter(item => !item.end).map(item => item.step));
  const failedStep = production.failure?.step ?? (/Dialogue recording did not meet|Recorded dialogue needs revised|Dialogue timing could not fit/.test(production.message ?? "") ? "dub" : undefined);
  const phaseSteps: Record<string, string[]> = {
    preparation: ["startupPlan", "startupText", "startupMedia"], story: ["direction", "script", "scriptRevision", "shotList", "cast", "references", "contractPlan"],
    visuals: ["previsPlan", "designs", "previsRender", "loras"], speech: ["dub", "dialogueTimingRepair", "ambience", "music"],
    video: ["texts", "clips"], finishing: ["roughCut", "film", "deliveryValidation", "report"], cleanup: [],
  };
  const phases = [
    { id: "preparation", done: !!production.runtime?.readyAt, running: active && !production.runtime?.readyAt },
    { id: "story", done: !!production.shotList && !!production.plan, running: ["direction", "script", "scriptRevision", "shotList", "cast", "contractPlan"].some(step => pending.has(step)) },
    { id: "visuals", done: !!assets && assets.every(item => assetDrawn(item)) && !!production.assets?.characters.every(item => !!item.loras) && !!production.previs?.every(shot => !!shot.video), running: ["previsPlan", "previsRender", "designs", "loras"].some(step => pending.has(step)) },
    { id: "speech", done: !!production.dub?.shots.every(shot => shot.lines.every(line => !!line.path) && (!shot.lines.length || !!shot.track)) && !!production.ambience?.every(item => !!item.bed?.videoSha256) && (!production.input.music || !!production.music), running: ["dub", "dialogueTimingRepair", "ambience", "music"].some(step => pending.has(step)) },
    { id: "video", done: totalShots > 0 && completedShots === totalShots, running: pending.has("clips") },
    { id: "finishing", done: production.status === "done" && !!production.film, running: ["film", "roughCut", "deliveryValidation"].some(step => pending.has(step)) },
    { id: "cleanup", done: production.cleanup?.status === "done", running: production.cleanup?.status === "running" },
  ];
  const end = active ? Date.now() : Date.parse(production.status === "done" && production.cleanup?.end ? production.cleanup.end : production.updatedAt);
  return {
    active, finished: production.status === "done" && !!production.film && production.cleanup?.status === "done", cleanupStatus: production.cleanup?.status ?? "unknown",
    elapsedSeconds: Math.max(0, (end - Date.parse(production.createdAt)) / 1000), totalShots, completedShots,
    failure: production.status === "failed" || production.status === "waiting" && !production.review ? {
      step: failedStep,
      message: productionGuidance(production)?.summary ?? translateMessage("製作流程發生錯誤，已完成的檔案與補充內容仍會保留。"),
      technical: production.detail ?? production.failure?.message ?? production.message,
    } : undefined,
    phases: phases.map(phase => ({ id: phase.id, status: production.status === "failed" && failedStep && phaseSteps[phase.id]?.includes(failedStep) ? "failed" as const : phase.done ? "done" as const : active && (phase.id === "cleanup" || production.status === "running") && phase.running ? "running" as const : "pending" as const })),
  };
}

export async function simpleWorkspaceDirectory() {
  const root = join(dirname(conf.path), "workspaces");
  await mkdir(root, { recursive: true });
  const { path } = await resolveWorkspacePath(await realpath(root), "simpleProduction", true);
  await mkdir(path, { recursive: true });
  return path;
}

export async function readProduction(cwd: string, id: string) {
  const path = (await resolveWorkspacePath(cwd, `${productionDirectory(id)}/production.json`)).path;
  const production = JSON.parse(await readFile(path, "utf8")) as Production;
  if (production.toonflowProduction !== 1 || production.id !== id) throw new Error("Not a Toonflow production file");
  if (production.conversationChanges) production.conversationChanges = conversationChangesSchema.parse(production.conversationChanges);
  const runtime = await readProductionText(cwd, { path: `${productionDirectory(id)}/runtimePreparation.json` }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (runtime) production.runtime = productionRuntimeSchema.parse(JSON.parse(runtime));
  if (production.runtime?.timings) {
    const recorded = new Set((production.timings ?? []).map(item => `${item.step}/${item.start}`));
    production.timings = [...production.timings ?? [], ...production.runtime.timings.filter(item => !recorded.has(`${item.step}/${item.start}`))];
  }
  if (production.runtime?.failure && production.status === "running") {
    production.status = "failed";
    production.message = production.runtime.failure;
    production.detail = "Background model preparation failed; the runtime checkpoint contains its completed stages.";
  }
  return production;
}

export async function saveProduction(cwd: string, production: Production, exclusive = false) {
  production.updatedAt = new Date().toISOString();
  const path = (await resolveWorkspacePath(cwd, `${productionDirectory(production.id)}/production.json`, true)).path;
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(production, null, 2)}\n`, { exclusive });
}

/** Reads a production text such as the script. */
export async function readProductionText(cwd: string, text: ProductionText) {
  return readFile((await resolveWorkspacePath(cwd, text.path)).path, "utf8");
}

export async function writeProductionText(cwd: string, path: string, content: string, exclusive = false) {
  const target = (await resolveWorkspacePath(cwd, path, true)).path;
  await mkdir(dirname(target), { recursive: true });
  await writeAtomic(target, content, { exclusive });
}

// Productions that were running when the server stopped, so it resumes them at start without a page open.
const registryPath = () => join(dirname(conf.path), "productions.json");
type Registry = { cwd: string; id: string }[];
let registryQueue: Promise<unknown> = Promise.resolve();

export async function readRegistry(): Promise<Registry> {
  return readFile(registryPath(), "utf8").then(text => JSON.parse(text) as Registry, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

/** Adds or removes a production; one in-process queue keeps the read-modify-write updates ordered. */
export function setRegistered(cwd: string, id: string, running: boolean) {
  const next = registryQueue.then(async () => {
    const list = (await readRegistry()).filter(item => item.cwd !== cwd || item.id !== id);
    await writeAtomic(registryPath(), JSON.stringify(running ? [...list, { cwd, id }] : list, null, 2));
  });
  registryQueue = next.catch(() => {});
  return next;
}
