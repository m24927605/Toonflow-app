import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { errorFromCause, success } from "@/lib/responseFormat";
import { generateMedia } from "@/utils/media/generation";
import { markVideoActivity, stopColabPoolWhenUnused } from "@/utils/media/colabPool";

type Job = { cwd: string; controller: AbortController; seen: number; result?: ReturnType<typeof errorFromCause> };

const jobs = new Map<string, Job>();
export const mediaWorkPending = () => [...jobs.values()].some(job => !job.result);
// ACT: A running job that no page has polled for this long is treated as abandoned (tab closed or frozen) and
// cancelled so paid work stops. Chrome runs timers in long-hidden tabs about once a minute, so this stays
// well above that. Resuming a job after a page reload would need the job ID stored in the node data.
const abandonAfter = 3 * 60_000;
// Finished results wait this long to be read before they are dropped.
const keepResult = 10 * 60_000;

/**
 * Runs paid work in the background and returns its job ID at once, so no HTTP connection waits on it. Work that saves
 * its own result to the workspace passes `abandon = false` and keeps running when no page waits for it.
 */
export function startJob(cwd: string, run: (signal: AbortSignal) => Promise<unknown>, abandon = true) {
  const id = crypto.randomUUID();
  const job: Job = { cwd, controller: new AbortController(), seen: Date.now() };
  jobs.set(id, job);
  const watchdog = setInterval(() => {
    if (abandon && Date.now() - job.seen > abandonAfter) job.controller.abort(new Error("Job cancelled: no page is waiting for it"));
  }, 15_000);
  run(job.controller.signal)
    .then(data => success(data), errorFromCause)
    .then(result => {
      job.result = result;
      clearInterval(watchdog);
      setTimeout(() => jobs.delete(id), keepResult);
    });
  return id;
}

export function startMediaJob(cwd: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest) {
  if (mediaType === "video") markVideoActivity();
  return startJob(cwd, async signal => {
    try { return await generateMedia(cwd, mediaType, request, signal); }
    finally { if (mediaType === "video") { markVideoActivity(); await stopColabPoolWhenUnused(); } }
  });
}

function findJob(id: string, cwd: string) {
  const job = jobs.get(id);
  if (!job || job.cwd !== cwd) throw Object.assign(new Error("Job not found; it may have expired or the server restarted"), { status: 404 });
  return job;
}

/** Returns the finished result once and forgets the job, or undefined while it still runs. */
export function readJob(id: string, cwd: string) {
  const job = findJob(id, cwd);
  job.seen = Date.now();
  if (job.result) jobs.delete(id);
  return job.result;
}

export function cancelJob(id: string, cwd: string) {
  findJob(id, cwd).controller.abort();
}
