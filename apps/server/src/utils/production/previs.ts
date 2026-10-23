import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { castNames, shotSpans } from "@toonflow/node-shared/shotList";
import { mkdir, readdir, rm, stat } from "@toonflow/file";
import { scheduler } from "node:timers/promises";
import { chromium } from "playwright-core";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, type Production } from "./state";
import { generateMedia } from "@/utils/media/generation";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { outfitView } from "./shots";
import { z } from "zod";
import { gazeDescriptions } from "./plan";

const cameraPoint = z.strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
export const cameraMeasurements = z.strictObject({ aspect: z.number().finite().positive(), frames: z.array(z.strictObject({ time: z.number().finite().nonnegative(), position: cameraPoint, target: cameraPoint, fov: z.number().finite().positive().lt(180) })).min(1).refine(frames => frames.length > 0 && frames[0]!.time === 0 && frames.every((frame, index) => index === 0 || frame.time > frames[index - 1]!.time), "Camera frames must start at zero and be strictly ordered") });

/**
 * Every shot's measured body blocking, visible cast and camera frames. Body-proxy headings do not measure
 * independent head or eye gaze. Once rendered, its opening is available as a colour layout
 * and a depth map, its animation as the previs video and as a depth video that drives the clip, and each person of the
 * opening alone as a full-body mannequin render in their opening pose, by name, for pose transfer.
 */
/** `timeline` says who moves when in the shot, which a long take's beats follow. */
export type ProductionPrevis = {
  shot: number; referenceOnly?: boolean; blocking: string; timeline?: string; framed: { opening: string[]; shown: string[]; gaze: Record<string, string>; directions: Record<string, string>; looks: Record<string, string>; bodies: Record<string, { posture: string; support?: string; supportHeight: number }>; camera?: z.infer<typeof cameraMeasurements> }; layout?: string; depth?: string; video?: string; depthVideo?: string;
  poses?: Record<string, string>;
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
  const reference = production.execution!.shots.filter(item => item.preparation === "reference").map(item => item.shot);
  const shots = previsShots(shotList, production).filter(item => !reference.includes(item.shot));
  const planned: ProductionPrevis = reference.map(shot => {
    const contract = production.plan!.shots.find(item => item.shot === shot)!;
    const names = contract.actors.map(actor => actor.name);
    return { shot, referenceOnly: true, blocking: `Static opening composition from the production contract, not measured 3D geometry. ${JSON.stringify(contract.actors)}`, framed: { opening: names, shown: names, gaze: Object.fromEntries(contract.actors.map(actor => [actor.name, `intended gaze: ${actor.gaze}`])), directions: Object.fromEntries(contract.actors.map(actor => [actor.name, actor.gaze])), looks: Object.fromEntries(contract.actors.map(actor => [actor.name, actor.pose])), bodies: {} } };
  });
  if (!shots.length) return planned;
  const job = { mode: "plan", directory: cwd, folder: previsFolder(production), ...model, aspect: aspectOf(production), script, shotList, shots };
  const { blocking, framed, timeline } = await runPage<{ blocking: string[]; framed?: ProductionPrevis[number]["framed"][]; timeline?: string[] }>(job, signal);
  if (blocking.length !== shots.length || framed?.length !== shots.length) throw new Error("Previs failed: the plan does not cover every shot");
  for (const item of framed) item.camera = cameraMeasurements.parse(item.camera);
  // Preserve the new plan, but invalidate renders from the previous timing or staging.
  for (const file of await readdir((await resolveWorkspacePath(cwd, previsFolder(production))).path)) {
    const match = /^shot(\d+)(?:Depth|Pose\d+)?\.(?:png|mp4)$/.exec(file);
    if (match) await rm((await resolveWorkspacePath(cwd, `${previsFolder(production)}/${file}`)).path);
  }
  return [...planned, ...shots.map((item, index) => ({ shot: item.shot, blocking: blocking[index]!, timeline: timeline?.[index] || undefined, framed: framed[index]! }))].sort((a, b) => a.shot - b.shot);
}

/** A still guide preserves a simple shot's opening without inventing a 3D performance. */
async function renderReference(cwd: string, production: Production, item: ProductionPrevis[number], framing: string | undefined, signal: AbortSignal, save: () => Promise<void>) {
  const shot = production.shots!.find(shot => shot.shot === item.shot)!;
  const contract = production.plan!.shots.find(shot => shot.shot === item.shot)!;
  const place = production.assets!.places.find(place => place.name === shot.place)!;
  const room = place.views?.[0];
  if (!room) throw new Error(`Shot ${shot.shot}: environment is not ready`);
  const people = contract.actors.map(actor => ({ actor, person: production.assets!.characters.find(person => person.name === actor.name)! }));
  const references = people.map(({ person }) => outfitView(person, shot)!);
  if (references.some(path => !path)) throw new Error(`Shot ${shot.shot}: outfit reference is not ready`);
  references.push(room);
  {
    if (!item.layout) {
      const start = new Date().toISOString();
      const started = performance.now();
      const [image] = await generateMedia(cwd, "image", {
        providerId: "qwenImage", modelId: "qwen_image_2_1_turbo",
        prompt: [
          "Compose one photorealistic opening frame.",
          framing ? `Use ${framing} framing.` : "",
          /中近景|近景|medium close-up|chest-up/i.test(framing ?? "") ? "Frame the head and upper chest, with the lower edge at the chest. Keep off-screen body parts and furniture outside the crop." : "",
          `Use the environment appearance from {{ref ${references.length}}}. Match the requested camera and physically consistent depth ordering.`,
          ...people.map(({ actor }, index) => `Keep ${actor.name}'s identity and outfit from {{ref ${index + 1}}}. ${actor.pose} Looking ${gazeDescriptions[actor.gaze]}.${actor.props.length ? ` Required props: ${actor.props.join("; ")}.` : ""}`),
          people.length ? "Keep the specified cast and visible anatomy consistent." : "The whole scene is unoccupied.",
        ].filter(Boolean).join(" "),
        images: references.map(path => ({ path, mimeType: /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png" })), ratio: production.input.ratio, size: "1K", outputDirectory: `${productionDirectory(production.id)}/previs`,
      }, signal);
      if (!image) throw new Error(`Shot ${shot.shot}: no opening reference was generated`);
      (production.timings ??= []).push({ step: `openingReference${shot.shot}`, start, end: new Date().toISOString(), seconds: (performance.now() - started) / 1000 });
      item.layout = image.path;
      await save();
    }
  }
  shot.poses = Object.fromEntries(people.map(({ actor }) => [actor.name, item.layout!]));
  const output = `${previsFolder(production)}/shot${shot.shot}.mp4`;
  await mkdir((await resolveWorkspacePath(cwd, previsFolder(production), true)).path, { recursive: true });
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const seconds = production.dub!.shots.find(item => item.shot === shot.shot)!.seconds;
  const start = new Date().toISOString();
  const started = performance.now();
  await new Promise<void>((resolve, reject) => ffmpeg(item.layout!).inputOptions("-loop 1").duration(seconds).fps(24).noAudio().outputOptions(["-c:v libx264", "-pix_fmt yuv420p", "-vf scale=trunc(iw/2)*2:trunc(ih/2)*2"]).output(output).on("end", () => resolve()).on("error", reject).run());
  item.video = output;
  (production.timings ??= []).push({ step: `staticGuide${shot.shot}`, start, end: new Date().toISOString(), seconds: (performance.now() - started) / 1000 });
  item.poses = {};
  await save();
}

/**
 * Renders the planned shots whose video is not saved yet and adds every shot's files to the production's previs. The
 * page saves a shot's video last, so a run stopped by a lost machine carries on after the last finished shot.
 */
export async function renderPrevis(cwd: string, production: Production, shotList: string, signal: AbortSignal, save: () => Promise<void>, ready: (shot: number) => void, assetsReady: (shot: number) => Promise<void>) {
  const folder = previsFolder(production);
  const spans = shotSpans(checkScript(shotList).shots, shotList);
  const referenceWork = Promise.all(production.previs!.filter(item => item.referenceOnly).map(async item => {
    await assetsReady(item.shot);
    if (!item.video) await renderReference(cwd, production, item, spans.find(shot => shot.shot === item.shot)?.size, signal, save);
    await Promise.all([item.layout!, item.video!].map(async path => stat((await resolveWorkspacePath(cwd, path)).path)));
    ready(item.shot);
  }));
  const stagedWork = (async () => {
    const previs = production.previs!.filter(item => !item.referenceOnly);
    if (!previs.length) return;
    const filesOf = (shot: number) => ({ layout: `${folder}/shot${shot}.png`, depth: `${folder}/shot${shot}Depth.png`, video: `${folder}/shot${shot}.mp4`, depthVideo: `${folder}/shot${shot}Depth.mp4` });
    // Named by their place in the opening, so a path holds no name from the script.
    const posesOf = (item: ProductionPrevis[number]) => Object.fromEntries(item.framed.opening.map((name, index) => [name, `${folder}/shot${item.shot}Pose${index + 1}.png`]));
    const unrendered = async () => (await Promise.all(previs.map(async item => {
      const files = [...Object.values(filesOf(item.shot)), ...Object.values(posesOf(item))];
      return Promise.all(files.map(async path => stat((await resolveWorkspacePath(cwd, path, true)).path))).then(() => [], (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return [item.shot];
      });
    }))).flat();
    const reported = new Set<number>();
    const reportReady = async (pending: number[]) => {
      for (const item of previs.filter(item => !pending.includes(item.shot) && !reported.has(item.shot))) {
        Object.assign(item, filesOf(item.shot), { poses: posesOf(item) });
        await save();
        reported.add(item.shot);
        ready(item.shot);
      }
    };
    let pending = await unrendered();
    await reportReady(pending);
    if (pending.length) {
      const render = pending.map(shot => ({ shot, ...filesOf(shot), poses: posesOf(previs.find(item => item.shot === shot)!) }));
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
  })();
  const results = await Promise.allSettled([referenceWork, stagedWork]);
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}
