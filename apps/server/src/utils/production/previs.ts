import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans } from "@toonflow/node-shared/shotList";
import { readdir, rm, stat } from "@toonflow/file";
import { scheduler } from "node:timers/promises";
import { chromium } from "playwright-core";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, type Production } from "./state";
import { z } from "zod";

const cameraPoint = z.strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
export const cameraMeasurements = z.strictObject({ aspect: z.number().finite().positive(), frames: z.array(z.strictObject({ time: z.number().finite().nonnegative(), position: cameraPoint, target: cameraPoint, fov: z.number().finite().positive().lt(180) })).min(1).refine(frames => frames.length > 0 && frames[0]!.time === 0 && frames.every((frame, index) => index === 0 || frame.time > frames[index - 1]!.time), "Camera frames must start at zero and be strictly ordered") });

/**
 * Every shot's measured blocking: where people are and who walks, the visible cast and the camera frames, never poses.
 * Body-proxy headings do not measure independent head or eye gaze. Once rendered, its opening is available as a colour
 * layout, its animation as the previs video, and the depth animation of the set and the
 * people who walk as the video that drives a clip with a walk or a camera move.
 */
/** `timeline` says who moves when in the shot, which a long take's beats follow. */
export type ProductionPrevis = {
  shot: number; blocking: string; timeline?: string; framed: { opening: string[]; shown: string[]; gaze: Record<string, string>; directions: Record<string, string>; looks: Record<string, string>; walkers?: string[]; bodies: Record<string, { support?: string }>; camera?: z.infer<typeof cameraMeasurements> }; layout?: string; video?: string; depthVideo?: string;
}[];

// The director model writes the plan of the whole film in one reply, which with a fix and a machine start can take
// many minutes; the page only counts as hung when it makes no progress for this long. The page is polled often, so the
// texts written from a plan start as soon as it is done, while the text model is held for them.
const stallTimeout = 20 * 60_000;
const progressPoll = 2_000;

const previsShots = (shotList: string, production: Production) => shotSpans(checkScript(shotList).shots, shotList)
  .map(span => ({ shot: span.shot, seconds: Number((span.end - span.start).toFixed(2)), cast: castNames(span), size: span.size ?? "", gaze: Object.fromEntries(production.plan!.shots.find(shot => shot.shot === span.shot)!.actors.map(actor => [actor.name, actor.gaze])) }));
const previsFolder = (production: Production) => `${productionDirectory(production.id)}/previs`;
const aspectOf = (production: Production) => {
  const [width, height] = production.input.ratio.split(":").map(Number) as [number, number];
  return width / height;
};

/** Cached geometry must describe exactly the shot's visible cast, including an empty frame. */
export function previsCastIssues(production: Production) {
  const guides = production.previs ?? [];
  const ids = guides.map(guide => guide?.shot);
  if (ids.length !== production.plan!.shots.length || new Set(ids).size !== ids.length || production.plan!.shots.some(shot => !ids.includes(shot.shot))) return ["Previs must cover every production shot exactly once"];
  return guides.flatMap(previs => {
    const expected = production.plan!.shots.find(shot => shot.shot === previs.shot);
    if (!expected) return [`Shot ${previs.shot}: previs has no matching production shot`];
    if (!previs.framed || !Array.isArray(previs.framed.opening) || !Array.isArray(previs.framed.shown) || [...previs.framed.opening, ...previs.framed.shown].some(name => typeof name !== "string")) return [`Shot ${previs.shot}: previs cast measurements are missing or invalid`];
    const names = expected.actors.map(actor => actor.name);
    const extra = [...new Set([...previs.framed.opening, ...previs.framed.shown])].filter(name => !names.includes(name));
    const missing = names.filter(name => !previs.framed.shown.includes(name));
    const duplicate = new Set(previs.framed.opening).size !== previs.framed.opening.length || new Set(previs.framed.shown).size !== previs.framed.shown.length;
    return extra.length || missing.length || duplicate ? [`Shot ${previs.shot}: previs cast differs from the production contract (extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}; duplicate: ${duplicate})`] : [];
  });
}

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
    // The page counts each step it finishes, such as a reply of the director model, which counts as progress too.
    let steps = 0;
    while (!(result = await page.evaluate(() => (globalThis as { previsResult?: T & { error?: string } }).previsResult))) {
      await scheduler.wait(progressPoll, { signal });
      const counted = await page.evaluate(() => (globalThis as { previsSteps?: number }).previsSteps ?? 0);
      if (counted !== steps || await progressed()) arm();
      steps = counted;
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
  const shots = previsShots(shotList, production);
  const job = { mode: "plan", directory: cwd, folder: previsFolder(production), ...model, aspect: aspectOf(production), script, shotList, shots };
  const { blocking, framed, timeline } = await runPage<{ blocking: string[]; framed?: ProductionPrevis[number]["framed"][]; timeline?: string[] }>(job, signal);
  if (blocking.length !== shots.length || framed?.length !== shots.length) throw new Error("Previs failed: the plan does not cover every shot");
  for (const item of framed) item.camera = cameraMeasurements.parse(item.camera);
  // Preserve the new plan, but invalidate renders from the previous timing or staging.
  for (const file of await readdir((await resolveWorkspacePath(cwd, previsFolder(production))).path)) {
    const match = /^shot(\d+)(?:Depth)?\.(?:png|mp4)$/.exec(file);
    if (match) await rm((await resolveWorkspacePath(cwd, `${previsFolder(production)}/${file}`)).path);
  }
  return shots.map((item, index) => ({ shot: item.shot, blocking: blocking[index]!, timeline: timeline?.[index] || undefined, framed: framed[index]! }));
}

/**
 * Renders the planned shots whose video is not saved yet and adds every shot's files to the production's previs. The
 * page saves a shot's video last, so a run stopped by a lost machine carries on after the last finished shot.
 */
export async function renderPrevis(cwd: string, production: Production, shotList: string, signal: AbortSignal, save: () => Promise<void>, ready: (shot: number) => void) {
  const folder = previsFolder(production);
  const previs = production.previs!;
  const filesOf = (shot: number) => ({ layout: `${folder}/shot${shot}.png`, video: `${folder}/shot${shot}.mp4`, depthVideo: `${folder}/shot${shot}Depth.mp4` });
  const unrendered = async () => (await Promise.all(previs.map(async item => {
    const files = Object.values(filesOf(item.shot));
    return Promise.all(files.map(async path => stat((await resolveWorkspacePath(cwd, path, true)).path))).then(() => [], (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return [item.shot];
    });
  }))).flat();
  const reported = new Set<number>();
  const reportReady = async (pending: number[]) => {
    for (const item of previs.filter(item => !pending.includes(item.shot) && !reported.has(item.shot))) {
      Object.assign(item, filesOf(item.shot));
      await save();
      reported.add(item.shot);
      ready(item.shot);
    }
  };
  let pending = await unrendered();
  await reportReady(pending);
  if (pending.length) {
    const render = pending.map(shot => ({ shot, ...filesOf(shot) }));
    await runPage({ mode: "render", directory: cwd, folder, aspect: aspectOf(production), shots: previsShots(shotList, production).filter(shot => previs.some(item => item.shot === shot.shot)), render }, signal, async () => {
      const now = await unrendered();
      if (now.length === pending.length) return false;
      pending = now;
      await reportReady(pending);
      return true;
    });
  }
  pending = await unrendered();
  if (pending.length) throw new Error(`Previs did not save shots ${pending.join(", ")}`);
  await reportReady(pending);
}
