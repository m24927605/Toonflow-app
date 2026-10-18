import { dirname, join } from "node:path";
import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import type { MessageDescriptor } from "@toonflow/i18n";
import conf from "@/utils/conf";
import type { ProductionAmbience } from "./ambience";
import type { ProductionDub } from "./dub";
import type { ProductionPrevis } from "./previs";
import type { ProductionClip } from "./video";
import type { ProductionShot } from "./shots";
import { resolveWorkspacePath } from "@/utils/workspace/files";

export const productionGates = ["script"] as const;
export type ProductionGate = typeof productionGates[number];
export const productionQualities = ["480p", "720p", "1080p"] as const;
export const productionRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

/** What the user starts a production with; only the outline and the length are required. */
export type ProductionInput = {
  outline: string;
  seconds: number;
  ratio: typeof productionRatios[number];
  quality: typeof productionQualities[number];
  /** Hard cap in Colab compute units for the whole production. */
  budget: number;
  gates: ProductionGate[];
  /** Photos of characters the user already has, by the name the outline uses. */
  photos: { name: string; path: string }[];
  /** Burns the dialogue into the film as subtitles. */
  subtitles: boolean;
  /** Scores the film with Suno music, which bills the sunoapi.org account rather than Colab units. */
  music: boolean;
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
  /** `waiting` stops for a person (a review gate or the budget), `failed` for an error a retry may clear. */
  status: "running" | "waiting" | "failed" | "done";
  /** Why it stopped, as a code the page words; `detail` carries the underlying error. */
  message?: string;
  detail?: string;
  /** The review the production waits on, with the change requests a person sent back. */
  review?: { gate: ProductionGate; notes?: string };
  approved: ProductionGate[];
  /** Compute units: the balance and the metered units when the production started, and the estimate shown then. */
  balanceAtStart?: number;
  meterAtStart?: number;
  estimate: number;
  script?: ProductionText;
  /** The shot list and the problems its timing check still finds after one fix, as message descriptors. */
  shotList?: ProductionText & { shots: number; issues: MessageDescriptor[] };
  /**
   * The cast and places of the script with their look; `base` is the photo or generated design every other view is
   * drawn from, `views` the reference images clips and LoRAs use.
   */
  assets?: { characters: ProductionAsset[]; places: ProductionAsset[] };
  shots?: ProductionShot[];
  dub?: ProductionDub;
  previs?: ProductionPrevis;
  videos?: ProductionClip[];
  /** General rules the diagnoses of failed clips found, which every later clip prompt, review and diagnosis follows. */
  lessons?: string[];
  /** How long each step took, in the order they finished, for the report and for finding the slow ones. */
  timings?: { step: string; start: string; seconds: number }[];
  roughCut?: string;
  /** Each shot's clip length in whole seconds, set by its dubbed lines. */
  clips?: { shot: number; clip: number }[];
  /** The style prompt of the Suno score, written with the other texts, and the score under the whole film, when the production asked for music. */
  musicStyle?: string;
  music?: string;
  /** Each place's ambience search, written with the other texts, and the recording laid under its shots. */
  ambience?: ProductionAmbience[];
  /** The finished film and its delivery report. */
  film?: string;
  report?: string;
  updatedAt: string;
};

/**
 * A person or place: `base` is the photo or design every view is drawn from, `views` its reference images (for a
 * person the face close-ups) and `outfits` a person's clothes in the story, each with its full-body views. A photo
 * fixes who someone is, never what they wear: the script decides that. `loras` are its trained LoRAs, empty when it
 * appears in too few shots to be worth one; `triggers` their trigger words, fixed when the LoRAs are planned, so texts
 * can name them while they train.
 */
export type ProductionAsset = {
  name: string; look: string; photo?: string; base?: string; views?: string[];
  outfits?: { name: string; look: string; adult?: boolean; views?: string[] }[];
  loras?: { family: "h3" | "qwen"; path: string; trigger: string }[];
  triggers?: Partial<Record<"h3" | "qwen", string>>;
};

export const productionDirectory = (id: string) => `productions/${id}`;

export async function readProduction(cwd: string, id: string) {
  const path = (await resolveWorkspacePath(cwd, `${productionDirectory(id)}/production.json`)).path;
  const production = JSON.parse(await readFile(path, "utf8")) as Production;
  if (production.toonflowProduction !== 1 || production.id !== id) throw new Error("Not a Toonflow production file");
  return production;
}

export async function saveProduction(cwd: string, production: Production) {
  production.updatedAt = new Date().toISOString();
  const path = (await resolveWorkspacePath(cwd, `${productionDirectory(production.id)}/production.json`, true)).path;
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(production, null, 2)}\n`);
}

/** Reads a production text such as the script. */
export async function readProductionText(cwd: string, text: ProductionText) {
  return readFile((await resolveWorkspacePath(cwd, text.path)).path, "utf8");
}

export async function writeProductionText(cwd: string, path: string, content: string) {
  const target = (await resolveWorkspacePath(cwd, path, true)).path;
  await mkdir(dirname(target), { recursive: true });
  await writeAtomic(target, content);
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
