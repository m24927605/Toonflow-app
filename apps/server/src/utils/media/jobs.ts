import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import { errorFromCause, success } from "@/lib/responseFormat";
import { generateMedia } from "@/utils/media/generation";

type MediaJob = { cwd: string; controller: AbortController; seen: number; result?: ReturnType<typeof errorFromCause> };

const jobs = new Map<string, MediaJob>();
// ACT: A running job that no page has polled for this long is treated as abandoned (tab closed or frozen) and
// cancelled so paid generation stops. Chrome runs timers in long-hidden tabs about once a minute, so this stays
// well above that. Resuming a job after a page reload would need the job ID stored in the node data.
const abandonAfter = 3 * 60_000;
// Finished results wait this long to be read before they are dropped.
const keepResult = 10 * 60_000;

/** Starts a generation in the background and returns its job ID at once, so no HTTP connection waits on it. */
export function startMediaJob(cwd: string, mediaType: "image" | "video" | "audio", request: MediaGenerationRequest) {
  const id = crypto.randomUUID();
  const job: MediaJob = { cwd, controller: new AbortController(), seen: Date.now() };
  jobs.set(id, job);
  const watchdog = setInterval(() => {
    if (Date.now() - job.seen > abandonAfter) job.controller.abort(new Error("Generation cancelled: no page is waiting for it"));
  }, 15_000);
  generateMedia(cwd, mediaType, request, job.controller.signal)
    .then(files => success(files), errorFromCause)
    .then(result => {
      job.result = result;
      clearInterval(watchdog);
      setTimeout(() => jobs.delete(id), keepResult);
    });
  return id;
}

function findJob(id: string, cwd: string) {
  const job = jobs.get(id);
  if (!job || job.cwd !== cwd) throw Object.assign(new Error("Generation job not found; it may have expired or the server restarted"), { status: 404 });
  return job;
}

/** Returns the finished result once and forgets the job, or undefined while it still runs. */
export function readMediaJob(id: string, cwd: string) {
  const job = findJob(id, cwd);
  job.seen = Date.now();
  if (job.result) jobs.delete(id);
  return job.result;
}

export function cancelMediaJob(id: string, cwd: string) {
  findJob(id, cwd).controller.abort();
}
