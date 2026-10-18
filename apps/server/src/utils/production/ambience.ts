import type { FfmpegCommand } from "@toonflow/ffmpeg";
import { mkdir, unlink, writeFile } from "@toonflow/file";
import { dirname } from "node:path";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, type Production } from "./state";

/**
 * A place's ambience bed: the search the text model wrote for it and, once fetched, the recording found, or null when
 * none was. The bed is a Freesound recording found through Openverse, as the clips with dubbed lines keep no sound but
 * their lines.
 */
export type ProductionAmbience = { place: string; query: string; bed?: AmbienceBed | null };
type AmbienceBed = { path: string; title: string; attribution: string; url: string };

/** Asks for a short search query per place for a recording of the steady background sound heard there. */
export function ambiencePrompt(places: { name: string; look: string; sounds: string[] }[]) {
  return [
    "For each place below, write an English search query of two to four words for a field recording of the steady background sound heard there, such as \"night room tone\", \"rain on roof\" or \"city street traffic\": no voices, no music, no single short effects.",
    "Output only JSON, one key per place name exactly as written, its query as the value.",
    "",
    ...places.map(place => `${place.name}: ${place.look}${place.sounds.length ? ` Sounds in its shots: ${place.sounds.join(" ")}` : ""}`),
  ].join("\n");
}

const api = "https://api.openverse.org/v1/audio/";
// Licences that allow commercial use without changing the film's own licence; CC BY asks for credit, which the
// delivery report gives.
const usableLicences = ["cc0", "pdm", "by"];
// ACT: The bed loops under its scene, so ten seconds of recording is enough.
const minBedMs = 10_000;
const maxBedBytes = 30 * 2 ** 20;
// The bed's mean level, about 20 dB under the lines, which are brought to -16 LUFS; it is ducked further while people
// speak. A fixed gain gets it there: room tone is often far quieter than loudnorm's dynamic mode can lift.
const bedLevel = -38;
// Two minutes of it are kept, looped under longer scenes, so a long recording does not become a huge WAV.
const bedSeconds = 120;

type OpenverseAudio = { title?: string; url?: string; license?: string; duration?: number | null; attribution?: string; foreign_landing_url?: string; filesize?: number | null };

/** The most relevant usable recording for `query`, in Openverse's own ranking. */
async function searchBed(query: string, signal: AbortSignal) {
  const params = new URLSearchParams({ q: query, source: "freesound", license_type: "commercial", page_size: "20" });
  const response = await fetch(`${api}?${params}`, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Openverse search failed (HTTP ${response.status})`);
  const { results = [] } = await response.json() as { results?: OpenverseAudio[] };
  return results
    .find(item => item.url?.startsWith("https://") && usableLicences.includes(item.license ?? "") && (item.duration ?? 0) >= minBedMs && item.filesize != null && item.filesize <= maxBedBytes);
}

const finished = (command: FfmpegCommand) => new Promise<string>((resolve, reject) => command.on("end", (_: unknown, log: string | null) => resolve(log ?? "")).on("error", reject).run());

/**
 * Fetches the bed of every place that has none yet, trying the query, then its first two words: the recording is
 * brought to the bed's loudness once, into a WAV beside the production, so the film's mix only loops and ducks it. A
 * place with nothing usable, or whose search or recording fails, gets null and keeps the clips' own sound.
 */
export async function fetchAmbience(cwd: string, production: Production, signal: AbortSignal) {
  const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
  const folder = `${productionDirectory(production.id)}/ambience`;
  for (const [index, item] of production.ambience!.entries()) {
    if (item.bed !== undefined) continue;
    try {
      item.bed = await fetchBed(cwd, ffmpeg, folder, index, item.query, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // ACT: an ambience bed is a finish, not the film: a failed search or recording leaves the place without one.
      console.warn(`[ambience] No bed for ${item.place}:`, error);
      item.bed = null;
    }
  }
}

/** One place's bed: the first usable recording for the query or its first two words, levelled into a WAV, or null. */
async function fetchBed(cwd: string, ffmpeg: Awaited<ReturnType<typeof createWorkspaceFfmpeg>>, folder: string, index: number, query: string, signal: AbortSignal): Promise<AmbienceBed | null> {
  let found: OpenverseAudio | undefined;
  for (const words of new Set([query, query.split(/\s+/).slice(0, 2).join(" ")])) {
    found = await searchBed(words, signal);
    if (found) break;
  }
  if (!found) return null;
  const response = await fetch(found.url!, { signal });
  if (!response.ok) throw new Error(`Downloading the ambience recording failed (HTTP ${response.status})`);
  // The search reported the size, but the download is held to it before it is read into memory.
  if (Number(response.headers.get("content-length") ?? 0) > maxBedBytes) {
    await response.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBedBytes) return null;
  const source = `${folder}/bed${index + 1}.source`;
  const path = `${folder}/bed${index + 1}.wav`;
  const sourcePath = (await resolveWorkspacePath(cwd, source, true)).path;
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, bytes);
  const measured = await finished(ffmpeg(source).audioFilters([`atrim=duration=${bedSeconds}`, "volumedetect"]).format("null").output("-"));
  const mean = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(measured)?.[1]);
  if (!Number.isFinite(mean)) throw new Error("Could not measure the ambience recording's loudness");
  await finished(ffmpeg(source).audioFilters([`atrim=duration=${bedSeconds}`, `volume=${(bedLevel - mean).toFixed(1)}dB`, "alimiter=limit=0.25:level=disabled", "aresample=48000", "aformat=channel_layouts=stereo"]).output(path));
  await unlink(sourcePath);
  return { path, title: found.title ?? "", attribution: found.attribution ?? "", url: found.foreign_landing_url ?? found.url! };
}
