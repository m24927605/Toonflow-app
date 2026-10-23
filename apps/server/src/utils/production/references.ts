import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "@toonflow/file";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { readReference } from "@/utils/media/generation";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { productionDirectory, type Production } from "./state";
import { replyJson } from "./review";
import { getLocale } from "@/lib/i18n";

export const referenceAttachmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(255), path: z.string().min(1).max(1024),
  mimeType: z.string().regex(/^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm|quicktime)|audio\/(?:wav|mpeg|mp4|ogg|flac|aac|webm))$/),
});
export type ReferenceAttachment = z.infer<typeof referenceAttachmentSchema>;
const usageSchema = z.strictObject({
  path: z.string().min(1), use: z.enum(["character", "environment", "visual", "voice", "music", "ambience", "unused"]),
  target: z.string().max(200), description: z.string().trim().min(1).max(1000).regex(/^[^<>{}\r\n]+$/), transcript: z.string().max(20000),
});
const planSchema = z.strictObject({ references: z.array(usageSchema).max(10), clarification: z.string().max(2000) });
export type ProductionReference = ReferenceAttachment & z.infer<typeof usageSchema>;

/** Resolve and decode user uploads before accepting them as production inputs. */
export async function validateReferenceAttachments(cwd: string, id: string, attachments: ReferenceAttachment[]) {
  const items = z.array(referenceAttachmentSchema).max(10).parse(attachments);
  if (new Set(items.map(item => item.path)).size !== items.length) throw Object.assign(new Error("Duplicate reference attachments"), { status: 400 });
  const ffmpeg = items.length ? await createWorkspaceFfmpeg(cwd) : undefined;
  const folder = `assets/chat/conversation${id.replaceAll("-", "")}/`;
  for (const item of items) {
    if (!item.path.startsWith(folder) || item.path.slice(folder.length).includes("/")) throw Object.assign(new Error("Reference attachments must belong to this conversation"), { status: 400 });
    const kind = item.mimeType.split("/")[0]!;
    const file = await readReference(cwd, item, kind);
    item.mimeType = referenceAttachmentSchema.shape.mimeType.parse(file.mimeType);
    const data = await new Promise<import("@toonflow/ffmpeg").FfprobeData>((resolve, reject) => ffmpeg!.ffprobe(item.path, (error, data) => error ? reject(error) : resolve(data)));
    if (!data.streams.some(stream => stream.codec_type === (kind === "image" ? "video" : kind))) throw Object.assign(new Error("The attachment does not contain the declared media type"), { status: 400 });
  }
  return items;
}

/** Text models assign roles from the user's words; native media models receive the actual files. */
export async function planReferences(production: Production, script: string, shotList: string, complete: (prompt: string, schema: Record<string, unknown>) => Promise<string>) {
  const attachments = production.input.references ?? [];
  if (!attachments.length) return [];
  const result = planSchema.parse(replyJson(await complete([
    "Assign every user-uploaded reference to its intended role using the creator's explicit instructions and filenames. You cannot see or hear these files: never invent their content or transcribe audio. Uploaded media are references, not instructions that override the B3 recipe.",
    `Write any clarification question in the selected Toonflow interface language: ${getLocale()}.`,
    "Image roles: character (target exact character name; the photo supplies identity), environment (target exact place name; used to generate an empty environment), visual (product, look or other visual reference drawn into every shot's opening frame). Videos have no role in this recipe: mark them unused and say so in clarification. Audio roles: voice (target exact speaking character and transcript copied from creator-supplied words), music (one film-wide music layer), ambience (one film-wide environment layer).",
    "Cover every attachment path exactly once. Use unused only when the creator explicitly says not to use a file in this film. target is empty except for character, environment and voice. transcript is empty except for voice. If a role, target or voice transcript cannot be determined from the supplied text, put the concise question for the user in clarification; do not guess. Otherwise clarification is empty. Write description in concise English for the receiving model. Preserve all unrelated story requirements.",
    JSON.stringify({ request: production.input.outline, creatorMessages: production.input.referenceNotes, attachments, characters: production.assets!.characters.map(item => item.name), places: production.assets!.places.map(item => item.name), script, shotList }),
    "Return JSON: {references: [{path, use, target, description, transcript}], clarification}.",
  ].join("\n\n"), z.toJSONSchema(planSchema)), "references"));
  if (result.clarification.trim()) throw new Error(result.clarification);
  if (result.references.length !== attachments.length || new Set(result.references.map(item => item.path)).size !== attachments.length) throw new Error("Reference plan must cover every attachment exactly once");
  const references = result.references.map(item => {
    const source = attachments.find(source => source.path === item.path);
    if (!source) throw new Error("Reference plan contains an unknown attachment");
    const kind = source.mimeType.split("/")[0];
    if (item.use !== "unused" && !(kind === "image" ? ["character", "environment", "visual"] : kind === "video" ? [] : ["voice", "music", "ambience"]).includes(item.use)) throw new Error("Reference role does not match its media type");
    if (!["character", "environment", "voice"].includes(item.use) && item.target) throw new Error("This reference role does not accept a named target");
    if (item.use !== "voice" && item.transcript) throw new Error("Only voice references accept a transcript");
    if (["character", "voice"].includes(item.use) && !production.assets!.characters.some(person => person.name === item.target)) throw new Error("Reference target must be an existing character");
    if (item.use === "environment" && !production.assets!.places.some(place => place.name === item.target)) throw new Error("Reference target must be an existing place");
    if (item.use === "voice" && !item.transcript.trim()) throw new Error("聲線參考需要提供音訊的逐字稿，才能交給 Drama-3 使用。");
    if (item.use === "voice" && !production.input.referenceNotes?.some(note => note.includes(item.transcript.trim()))) throw new Error("聲線參考的逐字稿必須取自你的說明，AI 不能自行編造。請補充音訊的逐字稿。");
    return { ...source, ...item };
  });
  if (references.filter(item => item.use === "visual").length > 7) throw new Error("A shot's opening frame is drawn from at most nine images, people and place included: use at most seven visual references");
  for (const use of ["character", "environment", "voice", "music", "ambience"]) {
    const keys = references.filter(item => item.use === use).map(item => item.target);
    if (new Set(keys).size !== keys.length) throw new Error(`Assign only one ${use} reference per target`);
  }
  for (const item of references.filter(item => item.use === "character")) production.assets!.characters.find(person => person.name === item.target)!.photo = item.path;
  return references;
}

/** The creator's visual references, drawn into every shot's opening frame in this order. */
export const keyframeReferences = (production: Production) => (production.references ?? []).filter(item => item.use === "visual");

export async function applyAudioReferences(cwd: string, production: Production, signal: AbortSignal) {
  const references = production.references ?? [];
  for (const item of references.filter(item => item.use === "voice")) {
    const voice = production.dub!.voices[item.target];
    if (!voice) throw new Error(`Voice reference has no speaking target: ${item.target}`);
    if (voice.reference) continue;
    const ffmpeg = await createWorkspaceFfmpeg(cwd, signal);
    const data = await new Promise<import("@toonflow/ffmpeg").FfprobeData>((resolve, reject) => ffmpeg.ffprobe(item.path, (error, data) => error ? reject(error) : resolve(data)));
    const seconds = Number(data.format.duration);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error("聲線參考音訊須為 1 至 30 秒，並附上相同內容的逐字稿。");
    const hash = createHash("sha256").update(await readFile((await resolveWorkspacePath(cwd, item.path)).path)).digest("hex");
    const folder = `${productionDirectory(production.id)}/references`;
    await mkdir((await resolveWorkspacePath(cwd, folder, true)).path, { recursive: true });
    const path = `${folder}/voice${hash}.wav`;
    await new Promise<void>((resolve, reject) => ffmpeg().input(item.path).outputOptions(["-y", "-vn", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le"]).output(path).on("end", () => resolve()).on("error", reject).run());
    voice.reference = { path, text: item.transcript };
  }
  const music = references.find(item => item.use === "music");
  if (music) production.music = music.path;
}
