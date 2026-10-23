<template>
  <el-button v-if="kind" text size="small" :icon="IconUserScan" :loading="training" :title="title" @click="train">{{ label }}</el-button>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElMessage, ElMessageBox } from "element-plus";
import { IconUserScan } from "@tabler/icons-vue";
import { t, translate } from "@toonflow/i18n/vue";
import { useNodeAi, useNodeFiles, type NodeLoraFamily, type NodeLoraRecord } from "@toonflow/nodes-scaffold/runtime";
import { roleOf, type NodeRoleData } from "../nodeRole";
import { listLoras } from "../loraRegistry";

const { node } = useNode<NodeRoleData>();
const { getNodes } = useVueFlow();
const ai = useNodeAi();
const files = useNodeFiles();
const training = ref(false);
// Characters train for video (Sulphur 2) and keyframes (Qwen-Image); scenes for keyframes, since videos start from them.
const kind = computed(() => node.data.role === "character" ? "character" as const : node.data.role === "scene" ? "scene" as const : undefined);
const families = computed<NodeLoraFamily[]>(() => kind.value === "character" ? ["ltx", "qwen"] : ["qwen"]);
const nameField = computed(() => kind.value === "character" ? "character" as const : "scene" as const);
const name = computed(() => String(node.data[nameField.value] ?? "").trim());
const records = ref<NodeLoraRecord[]>([]);
// The newest LoRA of this person or place per family, and the families it still lacks.
const trained = computed(() => families.value.flatMap(family => {
  const record = records.value.find(item => item.kind === kind.value && item.family === family && item.name === name.value);
  return record ? [record] : [];
}));
const missing = computed(() => families.value.filter(family => !trained.value.some(record => record.family === family)));
const label = computed(() => !trained.value.length ? translate("Train LoRA") : missing.value.length ? translate("Finish LoRA") : translate("Retrain LoRA"));
const title = computed(() => kind.value === "character"
  ? translate("Teach the AI this person's face and body, so every keyframe and video keeps them the same. Uses every image with the Character role and the same name.")
  : translate("Teach the AI this place, so every keyframe keeps its look. Uses every image with the Scene role and the same name."));

async function refresh() {
  if (kind.value) records.value = await listLoras(files.getWorkspaceFiles()).catch(() => records.value);
}
onMounted(refresh);

const imageOf = (item: { data?: unknown }) => (item.data as { outputs?: { image?: { value?: { url?: string } } } } | undefined)?.outputs?.image?.value?.url;

/** Asks for the name the person or place is known by, once, and keeps it on this image. */
async function askName() {
  const subject = kind.value === "character" ? translate("Who is this? Give the character name used in the script.") : translate("Which place is this? Give the scene name used in the script.");
  const value = await ElMessageBox.prompt(subject, label.value, { confirmButtonText: translate("Next"), cancelButtonText: translate("Cancel"), inputValidator: text => !!text.trim() })
    .then(result => result.value.trim(), () => "");
  if (value) node.data[nameField.value] = value;
  return value;
}

/** Trains the person's or place's LoRAs from every image of them on the canvas: the missing ones, or all again. */
async function train() {
  if (training.value || !kind.value) return;
  if (!imageOf(node)) return void ElMessage.warning(translate("Generate or upload this image first"));
  const subject = name.value || await askName();
  if (!subject) return;
  await refresh();
  const views = getNodes.value.filter(item => roleOf(item) === kind.value && String(item.data?.[nameField.value] ?? "").trim() === subject && imageOf(item))
    // The clicked image goes first: it is the reference for generated variants.
    .sort((a, b) => Number(b.id === node.id) - Number(a.id === node.id));
  const targets = missing.value.length ? missing.value : families.value;
  const models = targets.length > 1 ? translate("videos and keyframes") : targets[0] === "ltx" ? translate("videos") : translate("keyframes");
  const topUp = views.length < 12 ? ` ${t`Only ${views.length} of the 12 images it needs exist, so about ${16 - views.length} more in other clothes, places and light are generated from this image first (roughly 0.5–1 more units). Use the clearest image; giving more real views the name ${subject} makes it better.`}` : "";
  const go = await ElMessageBox.confirm(
    t`Train ${subject} for ${models}? It runs on Colab for about 30–90 minutes and uses roughly ${targets.reduce((sum, family) => sum + (family === "ltx" ? 5 : 0.5), 0)}–${targets.reduce((sum, family) => sum + (family === "ltx" ? 10 : 1.5), 0)} compute units. You can close this page; the LoRA is used automatically by "Build shot nodes" when it finishes.` + topUp,
    label.value, { confirmButtonText: translate("Train"), cancelButtonText: translate("Cancel"), type: "info" },
  ).then(() => true, () => false);
  if (!go) return;
  training.value = true;
  try {
    const { directory } = await files.getWorkspaceFiles().list();
    const results = await ai.trainLora({ directory, kind: kind.value, families: targets, name: subject, items: views.map(item => ({ path: imageOf(item)! })) });
    records.value = [...results, ...records.value];
    ElMessage.success(t`${subject} is trained; "Build shot nodes" uses it automatically`);
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) ElMessage.error(error instanceof Error ? error.message : translate("LoRA training failed"));
  } finally {
    training.value = false;
  }
}
</script>
