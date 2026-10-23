<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :generationStatus="generationStatus"
    :topVisible="node.selected"
    :bottomVisible="node.selected"
    :bottomWidth="actions?.mode === 'speed' ? 440 : 660"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    :fullscreenVisible="false"
    style="width: 360px">
    <template #topActions>
      <el-button :icon="IconScissors" :disabled="busy || !previewUrl" text title="截取音频" aria-label="截取音频" @click.stop="actions?.open('clip')">截取</el-button>
      <el-button :icon="IconGauge" :disabled="busy || !previewUrl" text title="音频变速" aria-label="音频变速" @click.stop="actions?.open('speed')">变速</el-button>
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="busy" text title="替换音频" aria-label="替换音频" @click.stop="fileInput?.click()">替换音频</el-button>
      <input ref="fileInput" type="file" accept="audio/*" hidden aria-label="选择替换音频" :disabled="busy" @change="replaceOutput" />
    </template>
    <div v-loading="generating || uploading" class="audioContent nopan" :aria-busy="generating || uploading">
      <audioPlayer v-if="previewUrl" ref="player" class="audioPreview" :src="previewUrl" @loadedmetadata="updateNodeInternals" />
      <div v-else class="audioEmpty" role="img" aria-label="暂无生成音频"><icon-music-bolt :size="48" stroke="1.25" aria-hidden="true" /></div>
    </div>
    <template #bottom>
      <div v-if="actions?.mode === 'speed'" ref="speedTarget" />
      <el-card v-else class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
        <el-input v-if="refList.some(item => item.dataType === 'AUDIO')" v-model="data.referenceTranscript" type="textarea" :disabled="busy" :maxlength="20000" aria-label="參考聲音的逐字稿" placeholder="輸入參考聲音中實際說出的完整文字" />
        <promptInput v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" placeholder="描述您想要的音频效果或输入待朗读文本" expandable />
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="busy"
            placeholder="选择模型"
            aria-label="音频生成模型"
            noDataText="请先在设置中添加音频模型"
            placement="top-start"
            @visible-change="visible => visible && loadModels().catch(error => showNodeError(error, translate('模型读取失败')))">
            <template #prefix><icon-music-bolt :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings v-model:language="data.language" v-model:voice="data.voice" v-model:emotion="data.emotion" v-model:sampleRate="data.sampleRate" v-model:format="data.format" :voices="selectedModel?.voices ?? []" :disabled="busy || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || actions?.processing || (!generating && (!generationPrompt || !selectedModel))"
            :title="generating ? '停止生成' : '生成音频'"
            :aria-label="generating ? '停止生成' : '生成音频'"
            @click="generating ? generationController?.abort() : startGeneration().catch(error => showNodeError(error, translate('音频生成失败')))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <audioActions ref="actions" :file="outputFile" :src="previewUrl" :target="speedTarget" :disabled="generating || deleting || uploading" @pause="player?.pause()" />
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElLoading, ElOption, ElOptionGroup, ElSelect } from "element-plus";
import { IconArrowUp, IconGauge, IconMusicBolt, IconPlayerStop, IconScissors, IconTransfer } from "@tabler/icons-vue";
import { getTargetValues, isTypeCompatible, nodeSkeleton, nodeTools, useNode, z, type NodeAudioRequest, type NodeHandle, type NodeInputValue, type NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import audioPlayer from "@toonflow/node-audio/audioPlayer";
import audioActions from "@toonflow/node-audio/audioActions";
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import generationSettings from "./components/generationSettings.vue";
import { formatOptions, languageOptions, sampleRateOptions } from "./audioSettings";

defineOptions({
  inheritAttrs: false,
  icon: IconMusicBolt,
  handles: [
    { id: "in", type: "target", dataType: ["AUDIO", "STRING"], label: "參考聲音限1個，文本不限" },
    { id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({ label: "音频生成" });
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; language: string; voice: string; emotion: string; referenceTranscript: string; sampleRate: number; format: string });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.language ??= "zh-CN";
// An empty voice leaves the choice to the provider's default.
data.value.voice ??= "";
data.value.emotion ??= "";
data.value.referenceTranscript ??= "";
data.value.sampleRate ??= 48000;
data.value.format ??= "wav";
const { refList, referenceMentions, setReferencePreview, removeReference, assertReferencesReady } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const deleting = ref(false);
const fileInput = ref<HTMLInputElement>();
const player = ref<InstanceType<typeof audioPlayer>>();
const actions = ref<InstanceType<typeof audioActions>>();
const speedTarget = ref<HTMLElement>();
let disposed = false;
let generationController: AbortController | undefined;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort(), () => void startGeneration().catch(error => showNodeError(error, translate("音频生成失败"))));
const { generating, status: generationStatus } = generationState;
const busy = computed(() => generating.value || uploading.value || deleting.value || !!actions.value?.processing);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
// A voice belongs to one model, so switching models drops a voice the new model does not offer.
watch(selectedModel, choice => {
  if (choice && data.value.voice && !choice.voices?.some(item => item.voice === data.value.voice)) data.value.voice = "";
});
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() => [data.value.prompt.trim(), ...refList.value.flatMap((item, index) =>
  item.dataType === "STRING" && item.value?.trim() ? [`Reference ${index + 1}:\n${item.value.trim()}`] : [])].filter(Boolean).join("\n\n"));
const outputFile = computed(() => outputs.value.audio?.dataType === "AUDIO" ? outputs.value.audio.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => showNodeError(error, "音频读取失败"));

function referencesAllowed(values: NodeInputValue[]) {
  return !values.some(item => isTypeCompatible(item.dataType, "IMAGE")) && values.filter(item => isTypeCompatible(item.dataType, "AUDIO")).length <= 1;
}

nodeEvent.on("canConnect", (connection, context) => {
  // ACT: Don't double-count when revalidating existing edges; sources without output still take a slot by declared type.
  const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle
    || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
  return referencesAllowed(getTargetValues(id, "in", context.nodes, [...edges, connection]));
});

onMounted(() => loadModels().catch(error => showNodeError(error, "模型读取失败")));
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then(items => {
    if (disposed || busy.value) return;
    models.value = items.filter(item => item.type === "audio");
    if (!formatOptions.includes(data.value.format)) data.value.format = "wav";
    // Existing nodes must also use the production model set.
    if (!models.value.some(item => JSON.stringify([item.providerId, item.modelId]) === data.value.model)) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration() {
  if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后重试");
  const choice = selectedModel.value;
  if (!choice) throw new Error("请先选择音频模型");
  if (!generationPrompt.value) throw new Error("请输入生成提示词或待朗读文本");
  if (!referencesAllowed(refList.value)) throw new Error("Drama-3 支援最多一個參考聲音，不接受圖片參考");
  assertReferencesReady();
  if (!refList.value.some(item => item.dataType === "AUDIO") && !data.value.emotion.trim()) throw new Error("請先在「聲線與表演」描述角色的聲音與說話方式");
  if (refList.value.some(item => item.dataType === "AUDIO") && !data.value.referenceTranscript.trim()) throw new Error("請提供參考聲音的完整逐字稿");
  if (!languageOptions.some(item => item.value === data.value.language) || !sampleRateOptions.includes(data.value.sampleRate) || !formatOptions.includes(data.value.format)) throw new Error("请重新选择有效的语种、采样率和输出格式");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  const input: Omit<NodeAudioRequest, "directory"> = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    language: data.value.language,
    voice: data.value.voice || undefined,
    emotion: data.value.emotion.trim() || undefined,
    sampleRate: data.value.sampleRate,
    format: data.value.format,
    outputDirectory: `assets/${id}`,
    audios: refList.value.flatMap(item => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType, text: data.value.referenceTranscript.trim() }] : []),
  };
  generationController = controller;
  generation = generationState.run(async () => {
    const { directory } = await workspace.list();
    controller.signal.throwIfAborted();
    const [result] = await ai.generateAudio({ ...input, directory }, controller.signal);
    controller.signal.throwIfAborted();
    if (!result) throw new Error("供应商未返回音频");
    outputs.value.audio = { dataType: "AUDIO", value: { url: result.path, mimeType: result.mimeType } };
  }).catch(error => showNodeError(error, "音频生成失败")).finally(() => {
    generationController = undefined;
  });
  return { status: "generating" };
}

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value || disposed) return;
  if (!file.type.startsWith("audio/")) return void showNodeError("请选择音频文件", "音频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("音频不能为空且不能超过 100 MB", "音频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: Replacing doesn't delete the old audio, preserving file references from copied nodes and undo history.
    outputs.value.audio = { dataType: "AUDIO", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "音频替换失败");
  } finally {
    uploading.value = false;
  }
}

nodeEvent.on("save", reason => {
  if (uploading.value || (reason === "reload" && busy.value)) throw new Error("音频处理中，请完成或取消后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("音频正在替换，请稍后删除节点");
  deleting.value = true;
  generationController?.abort();
  try {
    await Promise.all([generation, actions.value?.cancelAndWait()]);
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

function getConfig() {
  return {
    config: { providerId: selectedModel.value?.providerId ?? "", modelId: selectedModel.value?.modelId ?? "", language: data.value.language, voice: data.value.voice, emotion: data.value.emotion, sampleRate: data.value.sampleRate, format: data.value.format, referenceTranscript: data.value.referenceTranscript },
    models: models.value,
    languages: languageOptions,
    sampleRates: sampleRateOptions,
    formats: formatOptions,
    inputLimits: { text: "unlimited", audio: 1, image: 0 },
  };
}

nodeTools.register({
  name: "getConfig",
  description: "Read this Drama-3 node's configuration, voice direction, reference transcript, languages, sample rates and output formats without keys. One reference audio with an exact transcript is supported; images are not supported.",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});
nodeTools.register({
  name: "setConfig",
  description: "Modify Drama-3 language, voice direction, referenceTranscript, sample rate or format; emotion must describe the voice and performance for a new voice; referenceTranscript is the exact text spoken by connected reference audio; first use getConfig to query the options, and providerId and modelId must be provided together; voice takes a voice from the selected model's voices, and an empty string means the provider's default voice; does not modify the prompt or start generation",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    language: z.string().optional(),
    voice: z.string().optional(),
    emotion: z.string().max(500).optional(),
    sampleRate: z.number().int().positive().optional(),
    format: z.string().optional(),
    referenceTranscript: z.string().max(20000).optional(),
  }).refine(args => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (busy.value || disposed) throw new Error("音频正在处理或节点已关闭，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value : models.value.find(item => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效音频模型");
    if (args.language !== undefined && !languageOptions.some(item => item.value === args.language)) throw new Error("请选择 getConfig 返回的有效语种");
    if (args.sampleRate !== undefined && !sampleRateOptions.includes(args.sampleRate)) throw new Error("请选择 getConfig 返回的有效采样率");
    if (args.format !== undefined && !formatOptions.includes(args.format)) throw new Error("请选择 getConfig 返回的有效输出格式");
    if (args.voice && !choice.voices?.some(item => item.voice === args.voice)) throw new Error("请选择所选模型 voices 中的有效声线");
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (args.language !== undefined) data.value.language = args.language;
    if (args.voice !== undefined) data.value.voice = args.voice;
    if (args.emotion !== undefined) data.value.emotion = args.emotion;
    if (args.sampleRate !== undefined) data.value.sampleRate = args.sampleRate;
    if (args.format !== undefined) data.value.format = args.format;
    if (args.referenceTranscript !== undefined) data.value.referenceTranscript = args.referenceTranscript;
    return getConfig();
  },
});
nodeTools.register({
  name: "setPrompt",
  description: "Modify this node's audio generation prompt or text to be read aloud, supporting reference markers such as {{ref 1}}; only modifies the text and does not start generation",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt }) {
    if (deleting.value || disposed) throw new Error("节点正在删除或已关闭，请稍后修改");
    data.value.prompt = prompt;
    data.value.promptModel = prompt.split("\n").map(text => [{ type: "Write", text }]);
    return { prompt };
  },
});
nodeTools.register({
  name: "generateAudio",
  description: "Start background generation with the current prompt, model, language, sample rate, format and optional reference image or audio; images and audio are mutually exclusive with at most one in total, and text is unlimited; returns started immediately; use getGenerationStatus to query the result and cancelGeneration to stop",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.audioContent {
  position: relative;
  min-height: 144px;
  display: flex;
  align-items: center;

  .audioPreview { display: block; width: 100%; border-radius: var(--el-border-radius-base); }
  .audioEmpty { display: grid; place-items: center; width: 100%; min-height: 144px; color: var(--el-text-color-placeholder); }
  :deep(.el-loading-mask) { pointer-events: none; }
}
.promptCard {
  .promptFooter {
    display: flex;
    align-items: center;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;
      &:deep(.el-select__wrapper) { gap: 6px; padding: 0; box-shadow: none; background: transparent; }
    }
    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}
</style>
