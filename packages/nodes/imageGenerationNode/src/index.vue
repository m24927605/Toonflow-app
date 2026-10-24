<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :generationStatus="generationStatus"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :bottomWidth="660"
    :style="{ width: (previewUrl || inpaintGuideUrl) && imageWidth ? `${imageWidth + 18}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <roleSelect :roles="roles" />
      <assetLora />
      <el-button :icon="IconPanoramaHorizontal" :disabled="generating || deleting || uploading || editor?.busy || lighting?.generating || multiAngle?.generating || gridSplit?.splitting || panorama?.busy || !previewUrl" text title="全景图" aria-label="全景图" @click.stop="panorama?.open($event)">全景图<icon-chevron-down :size="14" /></el-button>
      <el-button :icon="IconBrush" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="局部重绘" aria-label="局部重绘" @click.stop="startEditor('inpaint')">局部重绘</el-button>
      <el-button :icon="IconSun" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="打光" aria-label="打光" @click.stop="openLighting">打光</el-button>
      <el-button :icon="IconCameraRotate" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="多角度" aria-label="多角度" @click.stop="openMultiAngle">多角度</el-button>
      <el-button :icon="IconLayoutGrid" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl" :loading="gridSplit?.splitting" text title="宫格切分" aria-label="宫格切分" @click.stop="gridSplit?.open($event)">宫格切分</el-button>
      <mediaHistory mediaType="image" :current="outputFile" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy" @select="outputs.image = { dataType: 'IMAGE', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting || lighting?.generating || multiAngle?.generating || panorama?.busy" text title="替换图片" aria-label="替换图片" @click.stop="fileInput?.click()">替换图片</el-button>
      <input ref="fileInput" type="file" accept="image/*" hidden aria-label="选择替换图片" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy" @change="replaceOutput" />
    </template>
    <template #topRightActions>
      <el-button v-if="isKeyframe" :icon="IconStar" text size="small" :title="translate('Make this keyframe the master shot: every other shot keyframe references it for lighting, colour, clothing and props')" @click.stop="setAsMasterShot">{{ translate("Set as master shot") }}</el-button>
      <gradeControl :outputUrl="outputFile?.url" kind="image" />
      <el-button :icon="IconPencil" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy || !previewUrl || gridSplit?.splitting" text title="标记" aria-label="标记" @click.stop="startEditor('mark')" />
    </template>
    <div v-loading="generating || uploading" class="imageContent nopan" :aria-busy="generating || uploading">
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :toolbarTarget="paintToolbar"
        :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy"
        alt="生成图片"
        @load="resizeImage"
        @error="showNodeError(translate('无法预览该图片'), translate('图片预览失败'))" />
      <div v-else-if="inpaintGuideUrl" class="inpaintGuide">
        <img :src="inpaintGuideUrl" alt="局部重绘标注图" draggable="false" @load="resizeImage" @error="showNodeError(translate('无法读取重绘标注图'), translate('重绘标注读取失败'))" />
        <span>红色标注为重绘区域</span>
      </div>
      <div v-else class="imageEmpty" role="img" aria-label="暂无生成图片">
        <icon-photo-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template v-if="editor?.mode !== 'mark'" #bottom>
      <div v-if="lightingVisible" ref="lightingTarget" />
      <div v-else-if="multiAngleVisible" ref="multiAngleTarget" />
      <el-card v-else class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <el-button v-if="inpaintGuideUrl && editor?.mode !== 'inpaint'" class="inpaintInfo" text :icon="IconBrush" @click="inpaintPreviewVisible = true">查看重绘标注</el-button>
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <promptInput v-if="editor?.mode === 'inpaint'" v-model="data.inpaintPromptModel" v-model:text="data.inpaintPrompt" :references="referenceMentions" expandable />
        <promptInput v-else v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <loraPicker v-if="loraFamily" v-model="loras" :family="loraFamily" class="loraRow" />
        <div class="promptFooter">
          <el-select
            v-if="editor?.mode !== 'inpaint'"
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加图片模型"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, translate('模型读取失败')))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-if="editor?.mode !== 'inpaint'"
            v-model:size="data.size"
            v-model:ratio="data.ratio"
            :sizes="sizeOptions"
            :ratios="ratioOptions"
            :disabled="generating || deleting || !selectedModel" />
          <seedLock v-if="editor?.mode !== 'inpaint'" v-model:keep="data.keepSeed" :seed="currentSeed" :disabled="generating || deleting" />
          <el-button v-if="editor?.mode === 'inpaint'" class="confirmButton" type="primary" :icon="IconCheck" :loading="editor.busy" :disabled="deleting || uploading || !generationPrompt" @click="confirmInpaint().catch(error => showNodeError(error, translate('重绘节点创建失败')))">确认</el-button>
          <el-button
            v-else
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || (!generating && (editor?.busy || !generationPrompt || !selectedModel))"
            :title="generating ? '停止生成' : '生成图片'"
            :aria-label="generating ? '停止生成' : '生成图片'"
            @click="generating ? generationController?.abort() : startGeneration().catch((error) => showNodeError(error, translate('图片生成失败')))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <imageLighting v-if="lightingVisible" ref="lighting" :src="previewUrl" :source="outputFile" :target="lightingTarget" :disabled="generating || deleting || uploading || gridSplit?.splitting" @close="lightingVisible = false" />
  <imageMultiAngle v-if="multiAngleVisible" ref="multiAngle" :src="previewUrl" :source="outputFile" :target="multiAngleTarget" :disabled="generating || deleting || uploading || gridSplit?.splitting" @close="multiAngleVisible = false" />
  <imagePanorama ref="panorama" :src="previewUrl" :source="outputFile" :disabled="generating || deleting || uploading || editor?.busy || lighting?.generating || multiAngle?.generating || gridSplit?.splitting" @open="openPanorama" />
  <imageGridSplit ref="gridSplit" :src="previewUrl" :disabled="generating || deleting || uploading || lighting?.generating || multiAngle?.generating || panorama?.busy" :active="node.selected" />
  <el-image-viewer v-if="inpaintPreviewVisible && inpaintGuideUrl" :urlList="[inpaintGuideUrl]" teleported @close="inpaintPreviewVisible = false" />
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
</template>

<script setup lang="ts">
import loraPicker from "@toonflow/node-shared/loraPicker";
import { activeLoras, listLoras, loraFamilyOf, pickLoras, type AttachedLora } from "@toonflow/node-shared/loraRegistry";
import { withTriggers } from "@toonflow/node-shared/loraTriggers";
import { t, translate } from "@toonflow/i18n/vue";
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElImageViewer, ElMessage, ElMessageBox } from "element-plus";
import { IconCheck, IconPhotoAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer, IconLayoutGrid, IconBrush, IconPencil, IconSun, IconCameraRotate, IconPanoramaHorizontal, IconChevronDown, IconStar } from "@tabler/icons-vue";
import { planMasterShot } from "@toonflow/node-shared/masterShot";
import roleSelect from "@toonflow/node-shared/roleSelect";
import seedLock from "@toonflow/node-shared/seedLock";
import assetLora from "@toonflow/node-shared/assetLora";
import { roleOf, registerRoleTool, type NodeRole } from "@toonflow/node-shared/nodeRole";
import { flashNode } from "@toonflow/nodes-scaffold/flashNode";
import { nodeSkeleton, nodeTools, useNode, z, type NodeMediaModel, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { useNodeGeneration } from "@toonflow/node-shared/useNodeGeneration";
import gradeControl from "@toonflow/node-shared/gradeControl";
import { confirmOnScreenText } from "@toonflow/node-shared/confirmOnScreenText";
import { confirmReferences } from "@toonflow/node-shared/confirmReferences";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import mediaHistory from "@toonflow/node-shared/mediaHistory";
import imageGridSplit from "@toonflow/node-image/imageGridSplit";
import imageEditor from "@toonflow/node-image/imageEditor";
import { useImageInpaint, type ImageInpaint } from "@toonflow/node-image/imageInpaint";
import imageLighting from "@toonflow/node-image/imageLighting";
import imagePanorama from "@toonflow/node-image/imagePanorama";
import imageMultiAngle from "@toonflow/node-image/imageMultiAngle";
import generationSettings from "./components/generationSettings.vue";

defineOptions({
  inheritAttrs: false,
  icon: IconPhotoAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "STRING", "CHARACTER"], label: "图片、文本、角色输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "图片生成",
});
const roles: NodeRole[] = ["keyframe", "character", "scene", "layout"];
registerRoleTool(roles);
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
// `seeds` holds the seed of each result this node drew, by file, so the current one can be drawn again with one change.
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; inpaintPrompt: string; inpaintPromptModel: PromptModel; model: string; size: string; ratio: string; inpaint?: ImageInpaint; loras?: AttachedLora[]; seeds?: Record<string, number>; keepSeed?: boolean });
const currentSeed = computed(() => data.value.seeds?.[outputFile.value?.url ?? ""]);
const loras = computed({ get: () => data.value.loras ?? [], set: (value: AttachedLora[]) => { data.value.loras = value; } });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.inpaintPrompt ??= "";
data.value.inpaintPromptModel ??= [];
data.value.model ??= "";
data.value.size ??= "";
data.value.ratio ??= "16:9";
const { refList, referenceMentions, setReferencePreview, removeReference, assertReferencesReady } = useNodeReferences();
const { findNode, getNodes, getEdges, addEdges } = useVueFlow();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const generateInpaint = useImageInpaint();
const paintToolbar = ref<HTMLElement>();
const lighting = ref<InstanceType<typeof imageLighting>>();
const lightingTarget = ref<HTMLElement>();
const lightingVisible = ref(false);
const multiAngle = ref<InstanceType<typeof imageMultiAngle>>();
const multiAngleTarget = ref<HTMLElement>();
const multiAngleVisible = ref(false);
const panorama = ref<InstanceType<typeof imagePanorama>>();
let disposed = false;
const deleting = ref(false);
const previewVisible = ref(false);
const inpaintPreviewVisible = ref(false);
const imageWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort(), batch => void startGeneration(batch).catch(error => showNodeError(error, translate("图片生成失败"))));
const { generating, status: generationStatus } = generationState;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const loraFamily = computed(() => loraFamilyOf(selectedModel.value?.providerId));
const sizeOptions = computed(() => (selectedModel.value?.imageSizes?.length ? selectedModel.value.imageSizes : ["2K"]));
const ratioOptions = computed(() => (selectedModel.value?.imageRatios?.length ? selectedModel.value.imageRatios : ["16:9"]));
watch(
  selectedModel,
  (choice) => {
    if (!choice) return;
    // ACT: Existing resolutions use the K unit; normalize units once others appear.
    // Unknown names sort after numeric options.
    if (!sizeOptions.value.includes(data.value.size)) data.value.size = sizeOptions.value.toSorted((left, right) =>
      (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity)
    )[0]!;
  },
  { flush: "sync" }
);
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() =>
  [
    (editor.value?.mode === "inpaint" ? data.value.inpaintPrompt : data.value.prompt).trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`Reference ${index + 1}:\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const inpaintGuideUrl = files.useFileUrl(
  () => data.value.inpaint?.guide ? { url: data.value.inpaint.guide, mimeType: "image/png" } : undefined,
  error => showNodeError(error, "重绘标注读取失败")
);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, "图片读取失败")
);

onMounted(() => loadModels().catch((error) => showNodeError(error, "模型读取失败")));
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || disposed) return;
  if (!file.type.startsWith("image/")) return void showNodeError("请选择图片文件", "图片替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("图片不能为空且不能超过 100 MB", "图片替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: Keep historical output files to avoid breaking undo history and references from copied nodes.
    outputs.value.image = { dataType: "IMAGE", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "图片替换失败");
  } finally {
    uploading.value = false;
  }
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (generating.value || deleting.value) return;
    models.value = items.filter((item) => item.type === "image");
    // Existing nodes must also use the production model set.
    if (!models.value.some(item => JSON.stringify([item.providerId, item.modelId]) === data.value.model)) {
      const first = models.value.find(item => item.modelId === "qwen_image_2_1");
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function confirmInpaint() {
  const inpaintEditor = editor.value;
  if (!inpaintEditor || inpaintEditor.mode !== "inpaint") throw new Error("请先进入局部重绘");
  if (inpaintEditor.busy || generating.value || deleting.value || uploading.value) return;
  if (!generationPrompt.value) throw new Error("请输入重绘提示词");
  assertReferencesReady();
  let prompt = generationPrompt.value.replace(/\{\{ref (\d+)\}\}/g, "Inpaint reference $1").replace(/^Reference (\d+):/gm, "Inpaint reference $1:");
  const images = refList.value.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const imageReferences = refList.value.flatMap((item, index) => item.dataType === "IMAGE" && item.value ? [index + 1] : []);
  if (imageReferences.length) prompt += `\nInpaint reference numbering (the first two images are the original image and the area guide image): ${imageReferences.map((reference, index) => `Inpaint reference ${reference} is image ${index + 3}`).join("; ")}.`;
  await inpaintEditor.createInpaint({ prompt, images }, new AbortController().signal);
}

async function startGeneration(batch = false) {
  if (!ratioOptions.value.includes(data.value.ratio)) throw new Error(`当前模型不支持比例 ${data.value.ratio}，请选择支持该比例的模型或更改比例`);
  const choice = selectedModel.value;
  if (generating.value) throw new Error("图片正在生成，请等待完成");
  if (panorama.value?.visible) throw new Error("请先关闭全景图，再启动图片生成");
  if (uploading.value) throw new Error("图片正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (lightingVisible.value) throw new Error("请先退出打光，再启动图片生成");
  if (multiAngleVisible.value) throw new Error("请先退出多角度，再启动图片生成");
  if (editor.value?.busy || editor.value?.mode === "mark") throw new Error("请先完成图片标记");
  if (editor.value?.mode === "inpaint") throw new Error("请先确认局部重绘，再到子节点生成");
  if (!generationPrompt.value) throw new Error("请输入生成提示词");
  const references = refList.value.filter(item => !data.value.inpaint || item.dataType !== "IMAGE" || item.value?.url !== data.value.inpaint.source);
  assertReferencesReady(references);
  if (!choice) throw new Error("请先选择图片模型");
  const characters = references.flatMap(item => item.dataType === "CHARACTER" && item.value ? [item.value] : []);
  if (characters.length > 1) throw new Error("一次只能引用一个角色身份");
  const character = characters[0];
  if (character && choice.character !== character.kind) {
    const supported = models.value.find(model => model.character === character.kind);
    throw new Error(supported ? t`角色“${character.name}”需要改用 ${supported.label} 模型生成` : t`没有可用于角色“${character.name}”的图片模型`);
  }
  const skipTextCheck = await confirmOnScreenText(generationPrompt.value, !batch);
  // Inpainting renumbers references itself, so the check only covers regular generation.
  if (!data.value.inpaint) await confirmReferences(generationPrompt.value, refList.value.map(item => translate(findNode(item.source)?.data?.label ?? "")), /depth/i.test(choice.modelId), !batch);
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  const attached = activeLoras(loras.value, choice.providerId);
  const inpaintData = data.value.inpaint;
  const input = {
    skipTextCheck: skipTextCheck || undefined,
    providerId: choice.providerId,
    modelId: choice.modelId,
    // Attached LoRAs only work when their trigger words are in the prompt.
    prompt: withTriggers(generationPrompt.value, attached),
    size: data.value.size,
    ratio: data.value.ratio,
    outputDirectory: `assets/${id}`,
    images: references.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    characterId: character?.id,
    ...attached.length ? { loras: attached.map(lora => ({ path: lora.path, strength: lora.strength })) } : {},
    ...data.value.keepSeed && currentSeed.value !== undefined ? { seed: currentSeed.value } : {},
  };
  if (inpaintData) {
    let imageIndex = 3 + (inpaintData.images?.length ?? 0);
    const mapping = refList.value.flatMap((item, index) => item.dataType === "IMAGE" && item.value
      ? [`Reference ${index + 1} / {{ref ${index + 1}}} is image ${item.value.url === inpaintData.source ? 1 : imageIndex++}`] : []);
    if (mapping.length) input.prompt += `\nReference numbering for the current node: ${mapping.join("; ")}.`;
  }
  generationController = controller;
  // ACT: The tool returns immediately; the node owns the task and cancels it on stop or unmount.
  generation = generationState.run(() => workspace.list()
    .then(({ directory }) => {
      controller.signal.throwIfAborted();
      return inpaintData
        ? generateInpaint({ ...input, directory }, inpaintData, controller.signal)
        : ai.generateImage({ ...input, directory }, controller.signal);
    })
    .then(([result]) => {
      controller.signal.throwIfAborted();
      if (!result) throw new Error("供应商未返回图片");
      outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } };
      if (result.seed !== undefined) data.value.seeds = { ...data.value.seeds, [result.path]: result.seed };
    }))
    .catch((error) => showNodeError(error, "图片生成失败"))
    .finally(() => {
      generationController = undefined;
    });
  return { status: "generating" };
}

const isKeyframe = computed(() => roleOf(node) === "keyframe");

/** Wires this keyframe as the master shot of every other shot keyframe, after confirming what changes. */
async function setAsMasterShot() {
  const plan = planMasterShot(findNode(id)!, getNodes.value, getEdges.value,
    marker => translate("Lighting, colour, clothing and props match {0}, but the composition, camera angle and poses follow the description below.", { 0: marker }));
  const shots = (list: number[]) => list.join(", ");
  const notes = [
    plan.already.length ? t`Already following this master: shots ${shots(plan.already)}.` : "",
    plan.otherMaster.length ? t`Shots ${shots(plan.otherMaster)} follow another master shot and are left unchanged.` : "",
  ].filter(Boolean);
  if (!plan.changes.length) return void ElMessage.info([translate("No other shot keyframe needs this master shot."), ...notes].join(" "));
  const regenerate = plan.changes.filter(item => item.hasImage).map(item => item.shot);
  const summary = [
    t`Connect this keyframe to ${plan.changes.length} shot keyframes (shots ${shots(plan.changes.map(item => item.shot))}) and add a line asking them to match its lighting, colour, clothing and props?`,
    regenerate.length ? t`Shots ${shots(regenerate)} already have images; regenerate them to apply the master shot.` : "",
    ...notes,
  ].filter(Boolean).join("\n");
  if (!await ElMessageBox.confirm(summary, translate("Set as master shot"), {
    confirmButtonText: translate("Connect"), cancelButtonText: translate("Cancel"), type: "info", customStyle: { whiteSpace: "pre-line" },
  }).then(() => true, () => false)) return;
  for (const change of plan.changes) {
    const target = findNode(change.nodeId);
    if (!target) continue;
    target.data = {
      ...target.data, prompt: change.prompt, promptModel: change.prompt.split("\n").map(text => [{ type: "Write", text }]),
      referenceOrder: { ...target.data.referenceOrder, in: change.referenceOrder }, masterShotId: id,
    };
    flashNode(target.data, translate("Master shot connected"));
  }
  addEdges(plan.changes.map(change => ({ id: crypto.randomUUID(), source: id, sourceHandle: "image", target: change.nodeId, targetHandle: "in" })));
  flashNode(node.data, translate("Master shot"));
  ElMessage.success(t`Connected the master shot to ${plan.changes.length} keyframes`);
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy)) throw new Error("图片处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || (editor.value?.busy && !generating.value)) throw new Error("图片处理中，请稍后删除节点");
  deleting.value = true;
  generationController?.abort();
  try {
    await generation;
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = (240 * image.naturalWidth) / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

function openPanorama() {
  editor.value?.cancel();
  lightingVisible.value = false;
  multiAngleVisible.value = false;
}

function openLighting() {
  if (generating.value || deleting.value || uploading.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || gridSplit.value?.splitting || !previewUrl.value) return;
  editor.value?.cancel();
  multiAngleVisible.value = false;
  lightingVisible.value = true;
}

function openMultiAngle() {
  if (generating.value || deleting.value || uploading.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || gridSplit.value?.splitting || !previewUrl.value) return;
  editor.value?.cancel();
  lightingVisible.value = false;
  multiAngleVisible.value = true;
}

function startEditor(mode: "inpaint" | "mark") {
  if (generating.value || deleting.value || uploading.value || editor.value?.busy || lighting.value?.generating || multiAngle.value?.generating || panorama.value?.busy || gridSplit.value?.splitting) return;
  lightingVisible.value = false;
  multiAngleVisible.value = false;
  editor.value?.start(mode);
}

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      size: data.value.size,
      ratio: data.value.ratio,
      keepSeed: data.value.keepSeed === true,
      seed: currentSeed.value,
    },
    models: models.value,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "Read this image generation node's current model, resolution, aspect ratio and the capabilities of the available image models, without keys; when the resolution or aspect ratio is not declared, 2K and 16:9 are used respectively; loras lists the LoRAs attached to this node and the trained ones its model can load (only Qwen-Image loads LoRAs)",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return { ...getConfig(), loras: await loraConfig() };
  },
});

nodeTools.register({
  name: "setConfig",
  description: "Modify this image generation node's model, resolution or aspect ratio, or keepSeed: draw the next image with the current result's seed (getConfig's seed, for models that report one) so only what you change differs; first use getConfig to query the available capabilities, and providerId and modelId must be provided together; does not modify the prompt or start generation",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    ratio: z.string().min(1).optional(),
    keepSeed: z.boolean().optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效图片模型");
    const sizes = choice.imageSizes?.length ? choice.imageSizes : ["2K"];
    const ratios = choice.imageRatios?.length ? choice.imageRatios : ["16:9"];
    if (args.size !== undefined && !sizes.includes(args.size)) throw new Error(`当前模型不支持分辨率 ${args.size}，可选：${sizes.join("、")}`);
    if (args.ratio !== undefined && !ratios.includes(args.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio}，可选：${ratios.join("、")}`);
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (args.size !== undefined) data.value.size = args.size;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    if (args.keepSeed !== undefined) data.value.keepSeed = args.keepSeed;
    return getConfig();
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "Modify this node's regular image generation prompt, supporting reference markers such as {{ref 1}}; does not modify the inpainting prompt or start generation",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    return { prompt: value };
  },
});

// The trained LoRAs of the workspace that the selected model loads, with the ones attached to this node.
async function loraConfig() {
  const family = loraFamily.value;
  const records = family ? (await listLoras(files.getWorkspaceFiles())).filter(item => item.family === family) : [];
  return { family: family ?? null, attached: loras.value, available: records.map(({ path, name, kind, trigger }) => ({ path, name, kind, trigger })) };
}

nodeTools.register({
  name: "setLoras",
  description: "Replace the LoRAs loaded with this node's image generation by trained Qwen-Image LoRAs from getConfig's loras.available, at most 4; strength defaults to 1 (sliders take -4 to 4) and an empty list removes them all. Their trigger words are added to the prompt when generating. Select the Qwen-Image model with setConfig first; does not start generation",
  parameters: z.strictObject({ loras: z.array(z.strictObject({ path: z.string().min(1), strength: z.number().min(-4).max(4).optional() })).max(4) }),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("The node is generating or being deleted; change its LoRAs later");
    await loadModels();
    signal?.throwIfAborted();
    const family = loraFamily.value;
    if (!family) throw new Error("The selected model loads no LoRAs; select Qwen-Image with setConfig first");
    loras.value = pickLoras(await listLoras(files.getWorkspaceFiles()), family, args.loras);
    return loraConfig();
  },
});

nodeTools.register({
  name: "generateImage",
  description: "Start this node's regular image generation in the background, using the regular generation prompt, model, resolution, aspect ratio and reference images; in inpainting mode you must exit it first; returns started immediately; use getGenerationStatus to query the result and cancelGeneration to stop generation",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
</script>

<style scoped lang="scss">
.imageContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .inpaintGuide {
    position: relative;
    width: 100%;
    img { display: block; width: 100%; }
    span { position: absolute; bottom: 8px; left: 8px; padding: 4px 8px; border-radius: 4px; background: #0009; color: #fff; font-size: 12px; }
  }

  .imageEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.promptCard {
  .inpaintInfo { margin-bottom: 8px; }
  .loraRow { margin-top: 8px; }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .confirmButton { margin-left: auto; }

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
