import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans } from "@toonflow/node-shared/shotList";
import { stat } from "@toonflow/file";
import { scheduler } from "node:timers/promises";
import { chromium } from "playwright-core";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, type Production } from "./state";

/**
 * Every shot's measured blocking as text for its clip prompt; who it shows by name, in the opening and at any moment,
 * whom the clip names and gives as references; where each person framed in the opening or at the end looks, in English
 * with the side of the frame, and the way each person of the opening turns their head, without names, for their pose;
 * and once the shot is rendered, its opening as a colour layout
 * and a depth map, its animation as the previs video, and each person of the opening alone as a full-body mannequin
 * render in their opening pose, by name, for pose transfer.
 */
export type ProductionPrevis = {
  shot: number; blocking: string; framed: { opening: string[]; shown: string[]; gaze: Record<string, string>; looks: Record<string, string> }; layout?: string; depth?: string; video?: string;
  poses?: Record<string, string>;
}[];

// The director model writes the plan of the whole film in one reply, which with a fix and a machine start can take
// many minutes; the page only counts as hung when it makes no progress for this long. The page is polled often, so the
// texts written from a plan start as soon as it is done, while the text model is held for them.
const stallTimeout = 20 * 60_000;
const progressPoll = 2_000;

const previsShots = (shotList: string) => shotSpans(checkScript(shotList).shots, shotList)
  .map(span => ({ shot: span.shot, seconds: Number((span.end - span.start).toFixed(2)), cast: castNames(span), size: span.size ?? "" }));
const previsFolder = (production: Production) => `${productionDirectory(production.id)}/previs`;
const aspectOf = (production: Production) => {
  const [width, height] = production.input.ratio.split(":").map(Number) as [number, number];
  return width / height;
};

/**
 * Runs a job on the page /previs-runner in a headless Chrome on the server and returns the page's result: the page loads
 * the Director's Studio plugin and runs it without a person, so it keeps going with no Toonflow page open. Chrome (not a
 * downloaded Chromium) is used, with the GPU on macOS, since previs needs WebGL and H.264 encoding. `progressed` is asked
 * after every poll whether the page has saved anything new.
 */
async function runPage<T extends object>(job: object, signal: AbortSignal, progressed: () => Promise<boolean> = async () => false) {
  const origin = process.env.TOONFLOW_APP_ORIGIN;
  if (!origin) throw new Error("The server address is not known yet; try again in a moment");
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: process.platform === "darwin" ? ["--use-angle=metal", "--enable-gpu"] : ["--enable-unsafe-swiftshader"],
  }).catch((error: unknown) => {
    throw new Error(`Automatic previs needs Google Chrome installed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  });
  const close = () => browser.close().catch(() => undefined);
  // A timer, not the poll, ends a page that makes no progress, so a page that stops answering cannot keep the poll, and
  // the text model held for the plan, waiting forever: closing the browser fails the wait.
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      void close();
    }, stallTimeout);
  };
  signal.addEventListener("abort", close, { once: true });
  arm();
  try {
    const page = await browser.newPage();
    await page.addInitScript(value => { (globalThis as { previsJob?: unknown }).previsJob = value; }, job);
    await page.goto(`${origin}/#/previs-runner`);
    let result: (T & { error?: string }) | undefined;
    while (!(result = await page.evaluate(() => (globalThis as { previsResult?: T & { error?: string } }).previsResult))) {
      await scheduler.wait(progressPoll, { signal });
      if (await progressed()) arm();
    }
    if (result.error) throw new Error(`Previs failed: ${result.error}`);
    return result;
  } catch (error) {
    if (stalled) throw new Error(`Previs made no progress for ${stallTimeout / 60_000} minutes; the runner seems stuck`);
    throw error;
  } finally {
    clearTimeout(watchdog);
    signal.removeEventListener("abort", close);
    await close();
  }
}

/**
 * Plans every shot's previs: the director model writes the plan of the whole film and the Director's Studio code stages,
 * frames and describes each shot, without rendering; the page saves the plan as plan.json in the previs folder for the
 * render. Returns every shot's blocking and who it shows.
 */
export async function planPrevis(cwd: string, production: Production, script: string, shotList: string, model: { providerId: string; modelId: string }, signal: AbortSignal): Promise<ProductionPrevis> {
  const shots = previsShots(shotList);
  const job = { mode: "plan", directory: cwd, folder: previsFolder(production), ...model, aspect: aspectOf(production), script, shotList, shots };
  const { blocking, framed } = await runPage<{ blocking: string[]; framed?: ProductionPrevis[number]["framed"][] }>(job, signal);
  if (blocking.length !== shots.length || framed?.length !== shots.length) throw new Error("Previs failed: the plan does not cover every shot");
  return shots.map((item, index) => ({ shot: item.shot, blocking: blocking[index]!, framed: framed[index]! }));
}

/**
 * Renders the planned shots whose video is not saved yet and adds every shot's files to the production's previs. The
 * page saves a shot's video last, so a run stopped by a lost machine carries on after the last finished shot.
 */
export async function renderPrevis(cwd: string, production: Production, shotList: string, signal: AbortSignal) {
  const folder = previsFolder(production);
  const previs = production.previs!;
  const filesOf = (shot: number) => ({ layout: `${folder}/shot${shot}.png`, depth: `${folder}/shot${shot}Depth.png`, video: `${folder}/shot${shot}.mp4` });
  // Named by their place in the opening, so a path holds no name from the script.
  const posesOf = (item: ProductionPrevis[number]) => Object.fromEntries(item.framed.opening.map((name, index) => [name, `${folder}/shot${item.shot}Pose${index + 1}.png`]));
  const unrendered = async () => (await Promise.all(previs.map(async ({ shot }) =>
    stat((await resolveWorkspacePath(cwd, filesOf(shot).video, true)).path).then(() => [], () => [shot])))).flat();
  let pending = await unrendered();
  if (pending.length) {
    const render = pending.map(shot => ({ shot, ...filesOf(shot), poses: posesOf(previs.find(item => item.shot === shot)!) }));
    await runPage({ mode: "render", directory: cwd, folder, aspect: aspectOf(production), shots: previsShots(shotList), render }, signal, async () => {
      const now = await unrendered();
      if (now.length === pending.length) return false;
      pending = now;
      return true;
    });
  }
  // A shot rendered before pose renders existed has none; it keeps its people's outfit views.
  for (const item of previs) {
    const poses = await Promise.all(Object.entries(posesOf(item)).map(async ([name, path]) =>
      stat((await resolveWorkspacePath(cwd, path, true)).path).then(() => [[name, path] as const], () => [])));
    Object.assign(item, filesOf(item.shot), { poses: Object.fromEntries(poses.flat()) });
  }
}
