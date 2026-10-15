import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans } from "@toonflow/node-shared/shotList";
import { readFile } from "@toonflow/file";
import { scheduler } from "node:timers/promises";
import { chromium } from "playwright-core";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, type Production } from "./state";

export type ProductionPrevis = { shot: number; layout: string; depth: string; video: string; blocking: string }[];

// The director model writes the previs plan of the whole film in one reply, which with a fix can take minutes, and each
// shot then takes about a minute to stage and render; the runner only counts as hung when it saves no shot for this
// long. Progress is checked every progressPoll.
const stallTimeout = 20 * 60_000;
const progressPoll = 15_000;

type SavedShot = { blocking: string; scene: unknown; plans: unknown[]; spec: unknown };

/**
 * Blocks and renders every shot's previs in a headless Chrome on the server: the page /previs-runner loads the
 * Director's Studio plugin and runs it without a person, so it keeps going with no Toonflow page open. Chrome (not
 * a downloaded Chromium) is used, with the GPU on macOS, since previs needs WebGL and H.264 encoding. The page saves
 * each finished shot with the film's previs plan and the shot plans so far, so a run stopped by a lost machine resumes
 * after the last saved shot with the same plan. Only that plan needs the director model: `holdModel` loads and holds it
 * when there is no plan yet, and its release is called once the first shot is saved, so the machine is not kept while
 * the shots render here.
 */
export async function renderPrevis(cwd: string, production: Production, script: string, shotList: string, model: { providerId: string; modelId: string }, signal: AbortSignal, holdModel: () => Promise<() => void>) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const shots = spans.map(span => ({ shot: span.shot, seconds: Number((span.end - span.start).toFixed(2)), cast: castNames(span), size: span.size ?? "" }));
  const folder = `${productionDirectory(production.id)}/previs`;
  const done: ProductionPrevis = [];
  let start: Pick<SavedShot, "spec" | "plans"> | undefined;
  for (const { shot } of shots) {
    const path = (await resolveWorkspacePath(cwd, `${folder}/shot${shot}.json`, true)).path;
    const saved = await readFile(path, "utf8").then(text => JSON.parse(text) as SavedShot).catch(() => undefined);
    if (!saved) break;
    done.push({ shot, layout: `${folder}/shot${shot}.png`, depth: `${folder}/shot${shot}Depth.png`, video: `${folder}/shot${shot}.mp4`, blocking: saved.blocking });
    start = { spec: saved.spec, plans: saved.plans };
  }
  if (done.length === shots.length) return done;
  const [width, height] = production.input.ratio.split(":").map(Number) as [number, number];
  // The runner stages every shot from the first, for continuity, and renders those after the plans it is given.
  const job = { directory: cwd, folder, ...model, aspect: width / height, script, shotList, shots, start };
  const origin = process.env.TOONFLOW_APP_ORIGIN;
  if (!origin) throw new Error("The server address is not known yet; try again in a moment");
  const release = start?.spec ? () => {} : await holdModel();
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: process.platform === "darwin" ? ["--use-angle=metal", "--enable-gpu"] : ["--enable-unsafe-swiftshader"],
  }).catch((error: unknown) => {
    release();
    throw new Error(`Automatic previs needs Google Chrome installed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  });
  const close = () => browser.close().catch(() => undefined);
  signal.addEventListener("abort", close, { once: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(value => { (globalThis as { previsJob?: unknown }).previsJob = value; }, job);
    await page.goto(`${origin}/#/previs-runner`);
    const savedShots = async () => (await Promise.all(job.shots.map(async ({ shot }) =>
      readFile((await resolveWorkspacePath(cwd, `${folder}/shot${shot}.json`, true)).path, "utf8").then(() => true, () => false)))).filter(Boolean).length;
    let saved = done.length;
    let progressAt = Date.now();
    let result: { done?: ProductionPrevis; error?: string } | undefined;
    while (!(result = await page.evaluate(() => (globalThis as { previsResult?: { done?: ProductionPrevis; error?: string } }).previsResult))) {
      await scheduler.wait(progressPoll, { signal });
      const now = await savedShots();
      if (now > saved) {
        [saved, progressAt] = [now, Date.now()];
        release();
      }
      else if (Date.now() - progressAt > stallTimeout) throw new Error(`Previs saved no shot for ${stallTimeout / 60_000} minutes; the runner seems stuck`);
    }
    if (result.error) throw new Error(`Previs failed: ${result.error}`);
    return [...done, ...result.done ?? []];
  } finally {
    release();
    signal.removeEventListener("abort", close);
    await close();
  }
}
