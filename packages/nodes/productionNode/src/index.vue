<template>
  <nodeSkeleton v-bind="nodeProps" v-model:bottomVisible="node.selected" topWidth="max-content" :generationStatus="generationStatus" :bottomWidth="520">
    <div class="productionContent nopan">
      <template v-if="state">
        <strong>{{ headline }}</strong>
        <span v-if="state.production.status === 'failed'" class="failure">{{ state.production.message }}</span>
        <span v-if="state.production.detail" class="failure">{{ state.production.detail }}</span>
        <span v-if="state.production.shotList">{{ t`Shot list: ${state.production.shotList.shots} shots` }}</span>
        <span v-for="issue in state.production.shotList?.issues ?? []" :key="issue.id" class="warning">{{ translate(issue) }}</span>
        <span>{{ t`Estimate ${state.estimate.total} units` }}</span>
      </template>
      <span v-else>{{ translate("Give an outline and a length; the AI writes the script and makes the film, stopping for your review.") }}</span>
    </div>
    <template #bottom>
      <el-card class="productionCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <template v-if="!state">
          <el-input v-model="form.outline" type="textarea" :autosize="{ minRows: 4, maxRows: 12 }" :placeholder="translate('Story outline: who, where, what happens')" :aria-label="translate('Story outline')" />
          <div class="formRow">
            <label>{{ translate("Length (seconds)") }} <el-input-number v-model="form.seconds" size="small" :min="5" :max="600" :step="5" controlsPosition="right" /></label>
            <label>{{ translate("Ratio") }}
              <el-select v-model="form.ratio" size="small" class="shortSelect"><el-option v-for="ratio in ratios" :key="ratio" :label="ratio" :value="ratio" /></el-select>
            </label>
            <label>{{ translate("Final quality") }}
              <el-select v-model="form.quality" size="small" class="shortSelect"><el-option v-for="quality in qualities" :key="quality" :label="quality" :value="quality" /></el-select>
            </label>
          </div>
          <div v-if="photos.length" class="photos">
            <span class="hint">{{ translate("Connected photos keep these people; name each as the outline does:") }}</span>
            <el-input v-for="photo in photos" :key="photo.key" v-model="form.names[photo.key]" size="small" :placeholder="translate('Character name')" :aria-label="translate('Character name')" class="photoName" />
          </div>
          <span v-else-if="!canvasCast.length" class="hint">{{ translate("Optional: connect a photo of each character to keep their look; without photos the AI designs them.") }}</span>
          <span v-if="canvasCast.length" class="hint">{{ t`Characters already on the canvas keep their look: ${canvasCast.map(item => item.name).join(", ")}` }}</span>
          <div class="formRow">
            <el-checkbox v-model="form.reviewScript">{{ translate("Let me review the script") }}</el-checkbox>
          </div>
          <div class="formRow">
            <el-checkbox v-model="form.subtitles">{{ translate("Subtitles from the dialogue") }}</el-checkbox>
            <el-checkbox v-model="form.music" :title="translate('Suno composes the score; it bills your sunoapi.org account, not Colab compute units')">{{ translate("Music by Suno (billed by sunoapi.org)") }}</el-checkbox>
          </div>
          <div v-if="quote" class="quote">
            <span>{{ t`Estimated cost: about ${quote.total} Colab compute units for ${quote.shots} shots.` }}</span>
          </div>
          <div class="footer">
            <el-button type="primary" :loading="busy" :disabled="!form.outline.trim()" @click="start">{{ translate("Start") }}</el-button>
          </div>
        </template>
        <template v-else>
          <div v-if="state.production.review?.gate === 'script' && state.production.status === 'waiting'" class="review">
            <span>{{ translate("The script is ready in the Script node to the right. Edit it there, or write what to change here.") }}</span>
            <el-input v-model="notes" type="textarea" :autosize="{ minRows: 2, maxRows: 6 }" :placeholder="translate('What to change (leave empty to approve)')" :aria-label="translate('What to change')" />
            <div class="footer">
              <el-button :loading="busy" :disabled="!notes.trim()" @click="answer(true)">{{ translate("Revise") }}</el-button>
              <el-button type="primary" :loading="busy" @click="answer(false)">{{ translate("Approve") }}</el-button>
            </div>
          </div>
          <div v-else-if="state.production.status === 'waiting' || state.production.status === 'failed' || interrupted" class="review">
            <div class="footer">
              <el-button type="primary" :loading="busy" @click="resume">{{ translate("Continue") }}</el-button>
            </div>
          </div>
          <div v-else-if="state.production.status === 'running'" class="footer">
            <el-button :loading="busy" @click="stop">{{ translate("Stop") }}</el-button>
          </div>
        </template>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { IconMovie } from "@tabler/icons-vue";
import { ElButton, ElCard, ElCheckbox, ElInput, ElInputNumber, ElMessage, ElMessageBox, ElOption, ElSelect } from "element-plus";
import { t, translate } from "@toonflow/i18n/vue";
import type { MessageDescriptor } from "@toonflow/i18n";
import { nodeSkeleton, useNode, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";

defineOptions({
  inheritAttrs: false,
  icon: IconMovie,
  handles: [{ id: "in", type: "target", dataType: ["IMAGE"], label: "Character photos" }] satisfies NodeHandle[],
});

type Quality = "480p" | "720p" | "1080p";
type Ratio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
type Estimate = { shots: number; total: number; steps: { step: string; units: number }[] };
type Production = {
  id: string;
  input: { seconds: number; ratio: Ratio; quality: Quality };
  status: "running" | "waiting" | "failed" | "done";
  message?: string;
  detail?: string;
  review?: { gate: "script"; notes?: string };
  script?: { path: string };
  shotList?: { path: string; shots: number; issues: MessageDescriptor[] };
  assets?: { characters: Asset[]; places: Asset[] };
  dub?: unknown; clips?: { shot: number; clip: number }[]; previs?: { shot: number; depth?: string; video?: string }[]; roughCut?: string;
  videos?: { shot: number; prompt?: string; video?: string }[];
  music?: string; film?: string; report?: string;
};
type Asset = { name: string; views?: string[]; outfits?: { name: string; views?: string[] }[]; loras?: { family: string; trigger: string }[] };
type State = { active: boolean; production: Production; script?: string; shotList?: string; report?: string; estimate: Estimate };
type TextKind = "script" | "shotList" | "report";
// `texts` are the text nodes this production made, each with the text last put into it, so a revision by the AI
// replaces it only while nobody has edited it.
type Data = {
  texts?: Partial<Record<TextKind, { node: string; synced: string }>>;
  // The image nodes this production made, by the image they show; `top` is where its rows of images start, below
  // everything that was on the canvas when the first of them was placed.
  images?: Record<string, string>;
  top?: number;
  roughCut?: string;
  film?: string;
  form?: { outline: string; seconds: number; ratio: Ratio; quality: Quality; reviewScript: boolean; subtitles: boolean; music: boolean; names: Record<string, string> };
  started?: boolean;
};

const ratios: Ratio[] = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const qualities: Quality[] = ["480p", "720p", "1080p"];
const { id, node, nodeProps, nodeEvent, files } = useNode({ label: "Auto production" });
const flow = useVueFlow();
const { refList } = useNodeReferences();
const data = computed(() => node.data as typeof node.data & Data);
data.value.form ??= { outline: "", seconds: 60, ratio: "16:9", quality: "720p", reviewScript: true, subtitles: true, music: false, names: {} };
const form = reactive(data.value.form);
const state = ref<State>();
const quote = ref<Estimate>();
const busy = ref(false);
const notes = ref("");

const photos = computed(() => refList.value.flatMap(item => {
  const url = (item.value as { url?: string } | undefined)?.url;
  return url ? [{ key: item.source, url }] : [];
}));
// People already on the canvas, one image each by their Character role name, join as photos, so the production keeps
// them (and any LoRA trained of them) instead of designing new people.
const canvasCast = computed(() => {
  const found = new Map<string, string>();
  for (const item of flow.getNodes.value) {
    const name = String(item.data?.character ?? "").trim();
    const url = (item.data?.outputs as { image?: { value?: { url?: string } } } | undefined)?.image?.value?.url;
    if (item.data?.role === "character" && name && url && !found.has(name)) found.set(name, url);
  }
  return [...found].map(([name, url]) => ({ name, url })).filter(item => !photos.value.some(photo => form.names[photo.key]?.trim() === item.name));
});

// A photo's name defaults to the character name its image node carries.
watch(photos, list => {
  for (const photo of list) form.names[photo.key] ??= String(flow.findNode(photo.key)?.data?.character ?? "").trim();
}, { immediate: true });

const completed = computed(() => state.value?.production.status === "done" && !!state.value.production.film);
// Marked running, but this server is not running it, such as a production copied from elsewhere: it waits for Continue.
const interrupted = computed(() => state.value?.production.status === "running" && !state.value.active);
const generationStatus = computed(() => !state.value || interrupted.value ? "idle" : state.value.production.status === "done" ? completed.value ? "succeeded" : "failed" : { running: "running", waiting: "idle", failed: "failed" }[state.value.production.status] as "idle" | "running" | "failed" | "succeeded");
const headline = computed(() => {
  const production = state.value!.production;
  if (production.status === "done" && !completed.value) return translate("Generation completed, but the film file is missing.");
  if (interrupted.value) return translate("Interrupted: nothing is running it now; Continue resumes it");
  if (production.status === "running") {
    if (!production.script) return translate("Writing the script…");
    if (!production.shotList) return translate("Writing the shot list…");
    const assets = production.assets ? [...production.assets.characters, ...production.assets.places] : [];
    // The previs plan comes first; then designs and LoRAs run side by side with the previs renders, the dub and the
    // texts written from the plan.
    if (production.assets && !production.previs) return translate("Blocking every shot in the previs…");
    const designing = !production.assets || assets.some(item => !item.views || (item.outfits ?? []).some(outfit => !outfit.views));
    const training = production.assets?.characters.some(item => !item.loras);
    const blocked = !!production.previs?.every(shot => shot.video);
    if (designing) return blocked ? translate("Designing the characters and places…") : translate("Designing the characters and places while blocking every shot in the previs…");
    if (training) return blocked ? translate("Training LoRAs so faces stay the same (about an hour)…") : translate("Training LoRAs so faces stay the same (about an hour) while blocking every shot in the previs…");
    if (!blocked) return translate("Blocking every shot in the previs…");
    if (!production.clips || production.clips.length !== production.shotList.shots) return translate("Recording the dialogue…");
    if (!production.videos || production.videos.some(item => !item.prompt)) return translate("Writing the video prompts…");
    if (production.videos.some(item => !item.video)) return t`Rendering the clips at ${production.input.quality} (${production.videos.filter(item => item.video).length}/${production.videos.length})…`;
    if (!production.roughCut) return translate("Joining the rough cut…");
    if (!production.film) return translate("Finishing the film: music, sound levels and subtitles…");
    return translate("Writing the delivery report…");
  }
  if (production.status === "failed") return translate("Stopped by an error; Continue tries again");
  return ({
    reviewScript: translate("Waiting for your review of the script"),
    stopped: translate("Stopped"),
    filmDone: translate("The film is generated and its delivery report is ready."),
  } as Record<string, string>)[production.message ?? ""] ?? production.message ?? "";
});

const headers = { "Content-Type": "application/json", "x-toonflow-workspace": "1" };
async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/production/${path}`, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers, cache: "no-store" });
  const json = await response.json().catch(() => ({})) as { code?: number; data?: T; message?: string };
  if (!response.ok || json.code !== 200) throw new Error(json.message || translate("Request failed"));
  return json.data as T;
}
const directory = async () => (await files.getWorkspaceFiles().list()).directory;

// The quote follows the form.
let quoteTimer: ReturnType<typeof setTimeout> | undefined;
// People whose LoRAs the workspace already has are quoted without training, so the names count too.
const castNames = computed(() => [...photos.value.map(photo => form.names[photo.key]?.trim() ?? ""), ...canvasCast.value.map(item => item.name)]);
watch(() => [form.seconds, form.quality, castNames.value.join("\n")] as const, () => {
  if (data.value.started) return;
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    quote.value = await api<Estimate>("estimate", { directory: await directory(), seconds: form.seconds, quality: form.quality, names: castNames.value }).catch(() => undefined);
  }, 400);
}, { immediate: true });

async function start() {
  const unnamed = photos.value.some(photo => !form.names[photo.key]?.trim());
  if (unnamed) return void ElMessage.warning(translate("Name every connected photo first"));
  const go = await ElMessageBox.confirm(
    t`Start an automatic production of about ${form.seconds} seconds? It uses about ${quote.value?.total ?? "?"} Colab units, with no spending limit. It stops for your requested review. It keeps running if you close this page.`,
    translate("Auto production"), { confirmButtonText: translate("Start"), cancelButtonText: translate("Cancel"), type: "info" },
  ).then(() => true, () => false);
  if (!go || flow.findNode(id) !== node) return;
  busy.value = true;
  try {
    await api("create", {
      directory: await directory(), id, outline: form.outline, seconds: form.seconds, ratio: form.ratio, quality: form.quality,
      gates: form.reviewScript ? ["script"] : [], subtitles: form.subtitles, music: form.music,
      mode: "expert", modelRecipe: "sulphur2",
      photos: [...photos.value.map(photo => ({ name: form.names[photo.key]!.trim(), path: photo.url })), ...canvasCast.value.map(item => ({ name: item.name, path: item.url }))],
    });
    data.value.started = true;
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("Request failed"));
  } finally {
    busy.value = false;
  }
}

/**
 * Puts a production text on the canvas as a text node with its role, to the right of the text it comes from, and keeps
 * it in step until someone edits it.
 */
function syncText(kind: TextKind, text: string) {
  const texts = data.value.texts ??= {};
  const textOf = (nodeId: string) => (flow.findNode(nodeId)?.data?.outputs as { text?: { value?: string } } | undefined)?.text?.value;
  const known = texts[kind];
  // A node made once is never made again: right after the page loads it may not be on the canvas yet, and one a
  // person deleted stays deleted.
  if (known) {
    const existing = flow.findNode(known.node);
    if (existing && text !== known.synced && textOf(existing.id) === known.synced) {
      (existing.data.outputs as { text: { value: string } }).text.value = text;
      known.synced = text;
    }
    return;
  }
  const source = kind === "shotList" && texts.script ? flow.findNode(texts.script.node) : undefined;
  const anchor = source ?? node;
  const nodeId = crypto.randomUUID();
  // The report goes below the script, which sits right of this node too.
  flow.addNodes([{ id: nodeId, type: "remote-textNode", position: { x: anchor.computedPosition.x + (anchor.dimensions.width || 360) + 120, y: anchor.computedPosition.y + (kind === "report" ? 720 : 0) }, data: {
    label: { script: translate("Script"), shotList: translate("Shot list"), report: translate("Delivery report") }[kind], outputs: {}, textSnapshot: text,
    ...kind === "report" ? {} : { role: kind },
  } }]);
  if (source) flow.addEdges([{ id: crypto.randomUUID(), source: source.id, sourceHandle: "text", target: nodeId, targetHandle: "in" }]);
  texts[kind] = { node: nodeId, synced: text };
}

const mimeOf = (path: string) => /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.webp$/i.test(path) ? "image/webp" : "image/png";

/**
 * Puts the characters' and places' images on the canvas below this node, as image nodes with the Character role, name
 * and outfit or the Scene role and name, which "Build shot nodes" and the LoRA buttons read: a row per person's face
 * close-ups, one per outfit, and one per place.
 */
function syncAssets(assets: NonNullable<Production["assets"]>) {
  const images = data.value.images ??= {};
  const rows = [
    ...assets.characters.flatMap(item => [
      { name: item.name, views: item.views ?? [], data: { role: "character", character: item.name } },
      ...(item.outfits ?? []).map(outfit => ({ name: `${item.name} · ${outfit.name}`, views: outfit.views ?? [], data: { role: "character", character: item.name, outfit: outfit.name } })),
    ]),
    ...assets.places.map(item => ({ name: item.name, views: item.views ?? [], data: { role: "scene", scene: item.name } })),
  ];
  const top = data.value.top ??= Math.max(...flow.getNodes.value.map(item => item.computedPosition.y + (item.dimensions.height || 240))) + 160;
  rows.forEach((row, index) => row.views.forEach((path, column) => {
    if (images[path]) return;
    const imageId = crypto.randomUUID();
    flow.addNodes([{ id: imageId, type: "remote-imageNode", position: { x: node.computedPosition.x + column * 260, y: top + index * 320 }, data: {
      label: row.name, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: mimeOf(path) } } }, ...row.data,
    } }]);
    images[path] = imageId;
  }));
}

/** Puts the finished film on the canvas as a video node below the rough cut, once. */
function syncFilm(path: string, quality: Quality) {
  if (data.value.film) return;
  const nodeId = crypto.randomUUID();
  flow.addNodes([{ id: nodeId, type: "remote-videoNode", position: { x: node.computedPosition.x - 520, y: node.computedPosition.y + 360 }, data: {
    label: t`Film (${quality})`, outputs: { video: { dataType: "VIDEO", value: { url: path, mimeType: "video/mp4" } } },
  } }]);
  data.value.film = nodeId;
}

/** Puts the rough cut on the canvas as a video node to the right of this node, once. */
function syncRoughCut(path: string, quality: string) {
  if (data.value.roughCut) return;
  const nodeId = crypto.randomUUID();
  flow.addNodes([{ id: nodeId, type: "remote-videoNode", position: { x: node.computedPosition.x - 520, y: node.computedPosition.y }, data: {
    label: t`Rough cut (${quality})`, outputs: { video: { dataType: "VIDEO", value: { url: path, mimeType: "video/mp4" } } },
  } }]);
  data.value.roughCut = nodeId;
}

async function refresh() {
  if (!data.value.started) return;
  try {
    state.value = await api<State>(`get?${new URLSearchParams({ directory: await directory(), id })}`);
    if (state.value.script) syncText("script", state.value.script);
    if (state.value.shotList) syncText("shotList", state.value.shotList);
    if (state.value.production.assets) syncAssets(state.value.production.assets);
    if (state.value.production.roughCut) syncRoughCut(state.value.production.roughCut, state.value.production.input.quality);
    if (state.value.production.film && state.value.production.status === "done" && completed.value) syncFilm(state.value.production.film, state.value.production.input.quality);
    if (state.value.report) syncText("report", state.value.report);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("Request failed"));
  }
}

async function act(run: () => Promise<unknown>) {
  busy.value = true;
  try {
    await run();
    await refresh();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("Request failed"));
  } finally {
    busy.value = false;
  }
}

/** Approves the reviewed script, or sends change requests; an in-place edit of the Script node is sent along. */
function answer(revise: boolean) {
  const scriptNode = state.value?.production.review?.gate === "script" ? data.value.texts?.script?.node : undefined;
  const edited = (scriptNode && (flow.findNode(scriptNode)?.data?.outputs as { text?: { value?: string } } | undefined)?.text?.value) || undefined;
  return act(async () => {
    await api("review", { directory: await directory(), id, ...revise ? { notes: notes.value } : {}, ...edited !== undefined && edited !== state.value?.script ? { script: edited } : {} });
    if (edited !== undefined && data.value.texts?.script) data.value.texts.script.synced = edited;
    notes.value = "";
  });
}
const resume = () => act(async () => api("resume", { directory: await directory(), id }));
const stop = () => act(async () => api("stop", { directory: await directory(), id }));
nodeEvent.on("delete", async () => {
  if (busy.value) throw new Error("Wait for the production operation to finish before deleting this node");
  if (data.value.started) await api("stop", { directory: await directory(), id });
});

// The page shows progress by asking every few seconds; the production itself runs on the server.
let poll: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  poll = setInterval(() => { if (data.value.started && state.value?.production.status !== "done") void refresh(); }, 5000);
});
onBeforeUnmount(() => {
  clearInterval(poll);
  clearTimeout(quoteTimer);
});
</script>

<style scoped lang="scss">
.productionContent {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 72px;
  max-width: 360px;
  padding: 8px 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);

  strong { font-size: 14px; color: var(--el-text-color-primary); }
  .failure { color: var(--el-color-danger); }
  .warning { color: var(--el-color-warning); }
}

.productionCard {
  .formRow, .photos, .quote {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    font-size: 12px;

    .shortSelect { width: 96px; }
    .photoName { width: 120px; }
  }

  .hint { display: block; margin-top: 10px; font-size: 12px; color: var(--el-text-color-secondary); }

  .review {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
}
</style>
