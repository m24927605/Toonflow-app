<template>
  <nodeSkeleton v-bind="nodeProps" v-model:bottomVisible="node.selected" topWidth="max-content" :generationStatus="generationStatus" :bottomWidth="460">
    <div class="loraContent nopan">
      <template v-if="data.results?.length">
        <strong>{{ data.results[0]!.name }} · {{ kindLabels[data.results[0]!.kind] }}</strong>
        <span v-for="result in data.results" :key="result.path">{{ t`${familyLabels[result.family]}: trigger word ${result.trigger}` }}</span>
      </template>
      <span v-else-if="training">{{ translate("Training on Colab, up to about an hour and a half. You can close this page; the LoRA appears in the LoRA menus when it finishes.") }}</span>
    </div>
    <template #bottom>
      <el-card class="loraCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
        <div class="loraOptions">
          <el-select v-model="kind" size="small" :disabled="training" :aria-label="translate('What the LoRA learns')">
            <el-option v-for="(label, value) in kindLabels" :key="value" :label="label" :value="value" />
          </el-select>
          <el-select v-model="familyChoice" size="small" :disabled="training" :aria-label="translate('Model')">
            <el-option :label="translate('Video and image (recommended)')" value="ltx,qwen" :disabled="kind === 'motion' || kind === 'slider'" />
            <el-option :label="familyLabels.ltx" value="ltx" :disabled="kind === 'slider'" />
            <el-option :label="familyLabels.qwen" value="qwen" :disabled="kind === 'motion'" />
          </el-select>
          <el-input v-model="name" size="small" :disabled="training" :placeholder="translate('Name')" :aria-label="translate('Name')" class="nameInput" />
        </div>
        <div v-if="kind === 'slider'" class="sliderFields">
          <el-input v-model="sliderBase" size="small" :disabled="training" :placeholder="translate('What the picture is, e.g. a close-up photo of a person who is')" :aria-label="translate('Slider base prompt')" />
          <el-input v-model="sliderPositive" size="small" :disabled="training" :placeholder="translate('The +1 end adds, e.g. laughing')" :aria-label="translate('Slider +1 end')" />
          <el-input v-model="sliderNegative" size="small" :disabled="training" :placeholder="translate('The -1 end adds, e.g. expressionless')" :aria-label="translate('Slider -1 end')" />
        </div>
        <div class="loraFooter">
          <span class="hint">{{ hint }}</span>
          <el-button v-if="training" @click="controller?.abort()">{{ translate("Cancel") }}</el-button>
          <el-button type="primary" :loading="training" :disabled="!ready" @click="train">{{ translate("Train") }}</el-button>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { IconBrain } from "@tabler/icons-vue";
import { ElButton, ElCard, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect } from "element-plus";
import { t, translate } from "@toonflow/i18n/vue";
import { nodeSkeleton, useNode, useNodeAi, type NodeHandle, type NodeLoraFamily, type NodeLoraKind, type NodeLoraRecord } from "@toonflow/nodes-scaffold/runtime";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import referenceItem from "@toonflow/node-shared/referenceItem";

defineOptions({
  inheritAttrs: false,
  icon: IconBrain,
  handles: [{ id: "in", type: "target", dataType: ["IMAGE", "VIDEO"], label: "Training material" }] satisfies NodeHandle[],
});
const { node, nodeProps, files } = useNode({ label: "Train LoRA" });
const { refList, setReferencePreview, removeReference, assertReferencesReady } = useNodeReferences();
const ai = useNodeAi();
const training = ref(false);
const failed = ref(false);
const controller = ref<AbortController>();
type Data = { kind?: NodeLoraKind; families?: NodeLoraFamily[]; name?: string; slider?: { base: string; positive: string; negative: string }; results?: NodeLoraRecord[] };
const data = computed(() => node.data as typeof node.data & Data);
// Looks train for both video and keyframes by default; motion is learned from clips, which only Sulphur 2 trains on,
// and sliders only for Qwen-Image.
const defaultFamilies = (value: NodeLoraKind): NodeLoraFamily[] => value === "motion" ? ["ltx"] : value === "slider" ? ["qwen"] : ["ltx", "qwen"];
const kind = computed({ get: () => data.value.kind ?? "character", set: (value: NodeLoraKind) => {
  data.value.kind = value;
  data.value.families = defaultFamilies(value);
} });
const families = computed(() => data.value.families ?? defaultFamilies(kind.value));
const familyChoice = computed({ get: () => families.value.join(","), set: (value: string) => { data.value.families = value.split(",") as NodeLoraFamily[]; } });
const name = computed({ get: () => data.value.name ?? "", set: (value: string) => { data.value.name = value; } });
const sliderField = (field: "base" | "positive" | "negative") => computed({
  get: () => data.value.slider?.[field] ?? "",
  set: (value: string) => { data.value.slider = { base: "", positive: "", negative: "", ...data.value.slider, [field]: value }; },
});
const sliderBase = sliderField("base");
const sliderPositive = sliderField("positive");
const sliderNegative = sliderField("negative");
const kindLabels = computed<Record<NodeLoraKind, string>>(() => ({
  character: translate("Character"), scene: translate("Scene"), costume: translate("Costume"), style: translate("Style"),
  motion: translate("Motion"), slider: translate("Slider"),
}));
const familyLabels = computed<Record<NodeLoraFamily, string>>(() => ({ ltx: translate("Video (Sulphur 2)"), qwen: translate("Image (Qwen-Image)") }));
// What each kind learns from; its captions leave that thing out so it binds to the trigger word.
const hint = computed(() => ({
  character: translate("Connect images of one person, one is enough; with fewer than 12, variants of the first in other clothes and places are generated, and more real views make it better."),
  scene: translate("Connect images of one place, one is enough; with fewer than 12, variants of the first in other light and framing are generated."),
  costume: translate("Connect at least 4 images of the outfit, worn by anyone."),
  style: translate("Connect at least 4 images in the look to learn, of varied subjects."),
  motion: translate("Connect at least 4 video clips of the movement, by varied people."),
  slider: translate("No material: the two ends are described in words."),
})[kind.value]);
const ready = computed(() => !training.value && !!name.value.trim() && (kind.value === "slider"
  ? !!sliderBase.value.trim() && !!sliderPositive.value.trim() && !!sliderNegative.value.trim()
  : refList.value.filter(item => item.value).length >= (kind.value === "character" || kind.value === "scene" ? 1 : 4)));
const generationStatus = computed(() => training.value ? "running" : failed.value ? "failed" : data.value.results?.length ? "succeeded" : "idle");

async function train() {
  if (!ready.value) return;
  const models = families.value.map(item => familyLabels.value[item]).join(" + ");
  const go = await ElMessageBox.confirm(t`Train a ${kindLabels.value[kind.value]} LoRA for ${models} on Colab? Each model trains on its own GPU at the same time: Qwen-Image about 30–60 minutes and roughly 0.5–1.5 compute units, Sulphur 2 about 45–90 minutes and roughly 5–10 units. You can close this page; the LoRA appears in the LoRA menus when it finishes.`, translate("Train LoRA"), {
    confirmButtonText: translate("Train"), cancelButtonText: translate("Cancel"), type: "info",
  }).then(() => true, () => false);
  if (!go) return;
  const current = controller.value = new AbortController();
  training.value = true;
  failed.value = false;
  try {
    assertReferencesReady();
    const items = kind.value === "slider" ? [] : refList.value.flatMap(item => {
      if (!item.value || !["IMAGE", "VIDEO"].includes(String(item.dataType))) return [];
      return [{ path: (item.value as { url: string }).url }];
    });
    const { directory } = await files.getWorkspaceFiles().list();
    data.value.results = await ai.trainLora({
      directory, kind: kind.value, families: families.value, name: name.value.trim(), items,
      ...kind.value === "slider" ? { slider: { base: sliderBase.value.trim(), positive: sliderPositive.value.trim(), negative: sliderNegative.value.trim() } } : {},
    }, current.signal);
    ElMessage.success(t`${name.value.trim()} is trained; pick it in the LoRA menu of generation nodes`);
  } catch (error) {
    if (current.signal.aborted) return;
    failed.value = true;
    ElMessage.error(error instanceof Error ? error.message : translate("LoRA training failed"));
  } finally {
    training.value = false;
    controller.value = undefined;
  }
}
</script>

<style scoped lang="scss">
.loraContent {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 72px;
  padding: 8px 4px;
  font-size: 12px;
  color: var(--el-text-color-regular);

  strong { font-size: 14px; color: var(--el-text-color-primary); }
}

.loraCard {
  .loraOptions, .sliderFields {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;

    .el-select { width: 140px; }
    .nameInput { flex: 1; min-width: 120px; }
  }

  .sliderFields { flex-direction: column; }

  .loraFooter {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;

    .hint { flex: 1; font-size: 12px; color: var(--el-text-color-secondary); }
  }
}
</style>
