import { translate } from "@toonflow/i18n";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans } from "@toonflow/node-shared/shotList";
import { previsInstructions } from "@toonflow/node-shared/previsInstructions";
import { readFile } from "@toonflow/file";
import { chromium } from "playwright-core";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, type Production } from "./state";

export type ProductionPrevis = { shot: number; layout: string; video: string; blocking: string }[];

// A previs of a few shots takes minutes; this bounds a runner that hangs.
const previsTimeout = 60 * 60_000;

type SavedShot = { blocking: string; scene: unknown; plans: unknown[] };

/**
 * Blocks and renders every shot's previs in a headless Chrome on the server: the page /previs-runner loads the
 * Director's Studio plugin and runs it without a person, so it keeps going with no Toonflow page open. Chrome (not
 * a downloaded Chromium) is used, with the GPU on macOS, since previs needs WebGL and H.264 encoding. The page saves
 * each finished shot with its set and plans, so a run stopped by a lost machine resumes after the last saved shot.
 */
export async function renderPrevis(cwd: string, production: Production, script: string, shotList: string, model: { providerId: string; modelId: string }, signal: AbortSignal) {
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const shots = previsInstructions(spans, 1).map((item, index) => ({
    shot: item.shot, instruction: item.lines.map(line => typeof line === "string" ? line : translate(line, undefined, "en")).join("\n"), cast: castNames(spans[index]!), size: spans[index]!.size ?? "",
    seconds: Number((spans[index]!.end - spans[index]!.start).toFixed(2)),
  }));
  const folder = `${productionDirectory(production.id)}/previs`;
  const done: ProductionPrevis = [];
  let start: Pick<SavedShot, "scene" | "plans"> | undefined;
  for (const { shot } of shots) {
    const path = (await resolveWorkspacePath(cwd, `${folder}/shot${shot}.json`, true)).path;
    const saved = await readFile(path, "utf8").then(text => JSON.parse(text) as SavedShot).catch(() => undefined);
    if (!saved) break;
    done.push({ shot, layout: `${folder}/shot${shot}.png`, video: `${folder}/shot${shot}.mp4`, blocking: saved.blocking });
    start = { scene: saved.scene, plans: saved.plans };
  }
  if (done.length === shots.length) return done;
  const [width, height] = production.input.ratio.split(":").map(Number) as [number, number];
  const job = { directory: cwd, folder, ...model, aspect: width / height, script, shotList, shots: shots.slice(done.length), start };
  const origin = process.env.TOONFLOW_APP_ORIGIN;
  if (!origin) throw new Error("The server address is not known yet; try again in a moment");
  const browser = await chromium.launch({
    channel: "chrome", headless: true,
    args: process.platform === "darwin" ? ["--use-angle=metal", "--enable-gpu"] : ["--enable-unsafe-swiftshader"],
  }).catch((error: unknown) => {
    throw new Error(`Automatic previs needs Google Chrome installed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  });
  const close = () => browser.close().catch(() => undefined);
  signal.addEventListener("abort", close, { once: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(value => { (globalThis as { previsJob?: unknown }).previsJob = value; }, job);
    await page.goto(`${origin}/#/previs-runner`);
    const handle = await page.waitForFunction(() => (globalThis as { previsResult?: unknown }).previsResult, undefined, { timeout: previsTimeout, polling: 2000 });
    const result = await handle.jsonValue() as { done?: ProductionPrevis; error?: string };
    if (result.error) throw new Error(`Previs failed: ${result.error}`);
    return [...done, ...result.done ?? []];
  } finally {
    signal.removeEventListener("abort", close);
    await close();
  }
}
