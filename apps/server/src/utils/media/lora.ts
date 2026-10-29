import { mkdir, mkdtemp, readFile, rm, writeFile } from "@toonflow/file";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findCommand } from "@/utils/cli";
import { colabLane, colabLanePending, colabPoolRestored, colabSessionName, createColabWorker } from "@/utils/media/colabPool";
import { resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import pipeline from "./loraColab.py" with { type: "text" };

export const loraKinds = ["character", "scene", "costume", "style", "motion", "slider"] as const;
export type LoraKind = typeof loraKinds[number];
export type LoraFamily = "ltx" | "qwen" | "krea2";
export type LoraInput = {
  /** One LoRA per family, trained side by side from the same items. */
  kind: LoraKind; families: LoraFamily[]; name: string;
  /** Workspace images or clips; a caption replaces the automatic one. */
  items: { path: string; caption?: string }[];
  /** A slider's two ends, added to the base prompt: +1 at full strength, -1 at negative strength. */
  slider?: { base: string; positive: string; negative: string };
  /** The trigger word of a family's LoRA when the caller fixed it beforehand; otherwise a new one is drawn. */
  triggers?: Partial<Record<LoraFamily, string>>;
};
/** Stored beside each LoRA as `loras/<trigger>.json`, so nodes find the workspace's LoRAs and their trigger words. */
export type LoraRecord = { name: string; kind: LoraKind; family: LoraFamily; trigger: string; path: string; createdAt: string };

// Character sets contain at least 32 source/generated images before optional face crops are added.
const setSizes: Partial<Record<LoraKind, { min: number; to: number }>> = { character: { min: 32, to: 32 }, scene: { min: 12, to: 16 } };
const rules: Partial<Record<LoraKind, string>> = {
  character: "The person is exactly the one shown in {{ref 1}}: the same face, eyes, nose, lips, skin tone, hairstyle and body. Only the clothing and the place change.",
  scene: "The place is exactly the one shown in {{ref 1}}, seen from the same side: the same architecture, materials, furniture and layout, every object where it is in {{ref 1}}.",
};
// Framing is spelled out because an image model otherwise copies the reference's composition. Characters change clothing
// and place so the LoRA learns only the person; scenes keep the reference's viewpoint, because views it does not show
// are invented and teach a different room.
const variants: Partial<Record<LoraKind, [ratio: string, scene: string][]>> = {
  character: [
    ["1:1", "Tight close-up of the person's face filling the frame, front view, neutral expression, even soft light, plain light grey background."],
    ["1:1", "Tight close-up of the person's face filling the frame, front view, speaking with the mouth half open, soft daylight, plain beige background."],
    ["1:1", "Tight close-up of the person's face in three-quarter view turned to the left, calm expression, soft window light, plain grey background."],
    ["1:1", "Tight close-up of the person's face in three-quarter view turned to the right, slight smile, warm indoor light, dark background."],
    ["1:1", "Tight close-up of the person's face seen from slightly above, looking down, quiet expression, soft lamp light, dark background."],
    ["1:1", "Tight close-up of the person's face seen from slightly below, looking up, hopeful expression, overcast daylight, pale sky background."],
    ["1:1", "Tight close-up of the person's face, eyes looking to the side, thoughtful expression, dim evening light, dark blue background."],
    ["1:1", "Tight close-up of the person's face in three-quarter view turned to the left, laughing, bright daylight, blurred garden background."],
    ["1:1", "Tight close-up of the person's face in three-quarter view turned to the right, speaking, soft lamp light, blurred room background."],
    ["1:1", "Tight close-up of the person's face filling the frame, gentle smile, wearing a plain white T-shirt, soft window light from the left, plain grey background."],
    ["1:1", "Tight close-up of the person's face filling the frame, serious expression, wearing a black turtleneck, warm lamp light, dark background."],
    ["1:1", "Tight close-up of the person's face filling the frame, laughing with an open mouth, wearing a denim jacket, bright daylight, blurred green background."],
    ["1:1", "Tight close-up of the person's face filling the frame, neutral expression, wearing a grey hoodie, even studio light, white background."],
    ["1:1", "Close-up side profile of the person facing left, calm expression, wearing a navy coat, soft daylight on a city street."],
    ["1:1", "Close-up side profile of the person facing right, slight smile, wearing a striped shirt, soft backlight, dark background."],
    ["1:1", "Close-up three-quarter view of the person looking slightly down, thoughtful expression, wearing a beige knit sweater, overcast light in a cafe."],
    ["3:4", "Half-body shot of the person sitting at a wooden kitchen table, looking at the camera, wearing a checked flannel shirt, warm evening light."],
    ["3:4", "Half-body shot of the person standing in a city park, relaxed smile, wearing a light trench coat, soft afternoon light."],
    ["2:3", "Full-body shot of the person standing on a beach, facing the camera, wearing a T-shirt and jeans, bright daylight."],
    ["2:3", "Full-body shot of the person walking on an office corridor, wearing a dark business suit, cool fluorescent light."],
    ["3:4", "Half-body shot of the person in a library between bookshelves, wearing a cardigan, soft lamp light."],
    ["3:4", "Half-body shot of the person in three-quarter view turned to the left, seated on a cushion at a low table, wearing a simple sweater, warm night lamp light."],
    ["3:4", "Half-body shot of the person in side profile facing right, standing by a window, wearing a plain shirt, soft daylight."],
    ["3:4", "Medium shot of the person from the waist up, looking at someone off the left of the frame, wearing a plain blouse or shirt, dim warm indoor light."],
    ["2:3", "Full-body shot of the person seated on the floor of a traditional room, three-quarter view, wearing casual home clothes, soft lamp light."],
    ["1:1", "Tight close-up of the person's face filling the frame, front view, lips gently parted, wearing a dark green shirt, diffuse daylight, plain grey background."],
    ["1:1", "Tight close-up of the person's face in three-quarter view turned to the left, neutral expression, wearing a white linen shirt, even studio light, pale blue background."],
    ["1:1", "Tight close-up of the person's face in three-quarter view turned to the right, thoughtful expression, wearing a brown cardigan, soft window light, plain cream background."],
    ["1:1", "Close-up left side profile of the person's face, lips slightly parted, wearing a grey crew-neck shirt, diffuse studio light, plain white background."],
    ["1:1", "Close-up right side profile of the person's face, neutral expression, wearing a navy sweater, overcast daylight, plain grey background."],
    ["1:1", "Tight close-up of the person's face filling the frame, front view, eyebrows slightly raised in surprise, wearing a beige shirt, soft frontal light, plain dark grey background."],
  ],
  scene: [
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, soft morning daylight."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, warm evening lamp light."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, at night lit only by its lamps."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, overcast grey light."],
    ["16:9", "The place exactly as framed in {{ref 1}}, empty, golden hour light."],
    ["16:9", "The left half of the place in {{ref 1}}, seen a little closer, empty, soft daylight."],
    ["16:9", "The right half of the place in {{ref 1}}, seen a little closer, empty, warm lamp light."],
    ["16:9", "The centre of the place in {{ref 1}}, seen closer, empty, soft daylight."],
    ["16:9", "The place in {{ref 1}} from the same side, the camera a few steps further back and lower, empty, evening light."],
    ["16:9", "The place in {{ref 1}} from the same side, the camera slightly to the left, empty, morning light."],
    ["16:9", "The place in {{ref 1}} from the same side, the camera slightly to the right, empty, lamp light."],
  ],
};

// How long one Codex image request may take before it is asked again; under load a request sat silent for over 15 minutes.
const codexTimeout = 20 * 60_000;
const codexAttempts = 4;
const codexConcurrency = 4;

/**
 * Draws the variants a small set lacks with Codex CLI's image_gen tool from the set's first image, four at a time: the
 * user requires LoRA training pictures to come from Codex. Each picture is asked for again when Codex times out or saves
 * nothing; a picture that never arrives fails the training instead of training on a smaller set.
 */
async function topUp(kind: LoraKind, reference: Uint8Array, count: number, signal?: AbortSignal) {
  const command = findCommand("codex", "Codex CLI not found. Install it and sign in with `codex login` to draw LoRA training pictures");
  const directory = await mkdtemp(join(tmpdir(), "toonflow-codex-"));
  try {
    await writeFile(join(directory, "reference.png"), reference);
    const scenes = (variants[kind] ?? []).slice(0, count);
    const draw = async ([ratio, scene]: [string, string], index: number) => {
      const file = `variant${String(index).padStart(2, "0")}.png`;
      const prompt = `Use your built-in image generation tool (image_gen) to create ONE photorealistic ${ratio} photograph and save it as ${file} in the current directory. ${`${scene} ${rules[kind]}`.replaceAll("{{ref 1}}", "the attached image")} The person, if any, is an adult and fully clothed. Natural texture, sharp focus. Do not write any text in the image. After saving, reply with only the saved file path.`;
      for (let attempt = 1; attempt <= codexAttempts; attempt++) {
        signal?.throwIfAborted();
        const child = Bun.spawn([command, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "workspace-write", "-C", directory, "--image", join(directory, "reference.png"), "-"], {
          stdin: new TextEncoder().encode(prompt), stdout: "ignore", stderr: "ignore", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(codexTimeout)]) : AbortSignal.timeout(codexTimeout),
        });
        await child.exited;
        const data = await readFile(join(directory, file)).catch(() => undefined);
        if (data?.length) return new Uint8Array(data);
      }
      throw new Error(`Codex did not draw LoRA training picture ${index + 1} after ${codexAttempts} attempts`);
    };
    const results: Uint8Array[] = [];
    for (let start = 0; start < scenes.length; start += codexConcurrency) {
      results.push(...await Promise.all(scenes.slice(start, start + codexConcurrency).map((scene, offset) => draw(scene, start + offset))));
    }
    return results;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Trainings running in this process, by workspace, kind and name.
const training = new Set<string>();

// Trainings queue on the A100 lanes of the Colab pool outside lane 2, whose disk holds H3, a running machine with the least queued work first: asking Colab
// for a machine of their own failed a film after an hour of refusals while the pool's A100s sat idle, and counting only
// trainings put one on the image lane, where the next set's images then waited the whole training. A lane without a
// machine opens one only when no lane has one.
const gpuLanes = [1, 3];
const workers = new Map(gpuLanes.map(index => [index, createColabWorker("loraTraining", index)]));
const laneTrainings = new Map<number, number>();
function trainingLane() {
  const rank = (index: number) => {
    const physical = colabLane(index);
    return (colabSessionName(physical) ? 0 : 100) + colabLanePending(physical) + (laneTrainings.get(physical) ?? 0);
  };
  return gpuLanes.reduce((best, index) => rank(index) < rank(best) ? index : best);
}

// A trigger word of plain letters the text encoder has no meaning for, so the LoRA owns it.
export const triggerWord = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), value => String.fromCharCode(97 + value % 26)).join("");

/**
 * Trains a LoRA for each model family on an A100 of the Colab pool at the same time and saves each with its record in the
 * workspace's `loras/` folder. Sulphur 2 (LTX-2.3) LoRAs learn from images and clips and serve video nodes; Qwen-Image
 * 2.1 LoRAs learn from images and serve image nodes; Krea 2 LoRAs learn from images and lock people in LUSTIFY v10 stills. The job writes the captions, leaving out what the LoRA
 * learns, and crops faces for characters; a character or scene set under `minImages` images is first topped up once
 * with Codex CLI variants of its first image, shared by every family.
 */
export async function trainLora(cwd: string, input: LoraInput, signal?: AbortSignal): Promise<LoraRecord[]> {
  // Training outlives the page, so a reopened page could start the same paid training again.
  const key = JSON.stringify([cwd, input.kind, input.name]);
  if (training.has(key)) throw new Error(`The ${input.kind} LoRA "${input.name}" is already training; it appears in the LoRA menus when it finishes`);
  training.add(key);
  try {
    return await trainSet(cwd, input, signal);
  } finally {
    training.delete(key);
  }
}

async function trainSet(cwd: string, input: LoraInput, signal?: AbortSignal) {
  const sources = await Promise.all(input.items.map(async ({ path, caption }) => ({
    extension: path.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "png", caption,
    data: new Uint8Array(await readFile((await resolveWorkspacePath(cwd, path)).path, { signal })),
  })));
  const size = setSizes[input.kind];
  if (input.kind === "character" && !sources.length) throw new Error("Character LoRA training requires at least one identity reference image");
  const extra = size && sources.length && sources.length < size.min ? await topUp(input.kind, sources[0]!.data, size.to - sources.length, signal) : [];
  const items = [...sources, ...extra.map(data => ({ extension: "png", caption: undefined, data }))];
  if (input.kind === "character" && items.length < size!.min) throw new Error(`Character LoRA training requires at least ${size!.min} images before face crops; prepared ${items.length}`);
  // A family that fails does not stop the other, whose LoRA is kept; the error names what failed.
  const results = await Promise.allSettled(input.families.map(family => trainFamily(cwd, input, family, items, signal)));
  const failed = results.flatMap((result, index) => result.status === "rejected"
    ? [`${input.families[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`] : []);
  const records = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  if (failed.length) throw new Error(`LoRA training failed for ${failed.join("; ")}${records.length ? ` (saved: ${records.map(record => record.trigger).join(", ")})` : ""}`);
  return records;
}

async function trainFamily(cwd: string, input: LoraInput, family: LoraFamily, items: { extension: string; caption?: string; data: Uint8Array }[], signal?: AbortSignal) {
  const trigger = input.triggers?.[family] ?? triggerWord();
  const jobName = `lora${crypto.randomUUID().replaceAll("-", "")}`;
  const uploads = items.flatMap(({ extension, caption, data }, index) => {
    const name = `${jobName}Item${String(index).padStart(2, "0")}`;
    return [{ name: `${name}.${extension}`, data }, ...caption ? [{ name: `${name}.txt`, data: caption.replaceAll("{trigger}", trigger) }] : []];
  });
  const job = { trigger, family, kind: input.kind, ...input.slider ? { slider: input.slider } : {} };
  // A lane whose machine is still being taken back after a restart looked empty, and a training then asked Colab for a
  // new A100, which the account refused while that machine sat idle.
  await colabPoolRestored();
  const index = trainingLane();
  const physical = colabLane(index);
  laneTrainings.set(physical, (laneTrainings.get(physical) ?? 0) + 1);
  let lora: Uint8Array;
  try {
    [lora] = await workers.get(index)!.run((session, jobSignal) => session.job({ script: pipeline, runtime: "loraTraining", uploads: [{ name: `${jobName}.json`, data: JSON.stringify(job) }, ...uploads], env: { LORA_JOB: jobName }, outputs: [`/content/${jobName}.safetensors`], detached: true }, jobSignal), signal) as [Uint8Array];
  } finally {
    laneTrainings.set(physical, laneTrainings.get(physical)! - 1);
  }
  const record: LoraRecord = { name: input.name, kind: input.kind, family, trigger, path: `loras/${trigger}.safetensors`, createdAt: new Date().toISOString() };
  const target = await resolveWorkspacePath(cwd, record.path, true);
  await mkdir(dirname(target.path), { recursive: true });
  await writeWorkspaceFile(target.path, lora, true);
  await writeWorkspaceFile((await resolveWorkspacePath(cwd, `loras/${trigger}.json`, true)).path, `${JSON.stringify(record, null, 2)}\n`, true);
  return record;
}
