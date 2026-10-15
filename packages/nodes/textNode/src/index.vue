<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="downloadUrl"
    :downloadName="`${nodeProps.label || '文本'}.md`"
    :generationStatus="generationStatus"
    :bottomWidth="660"
    @fullscreen="fullscreen = true; editing = true">
    <template #topActions>
      <roleSelect :roles="['script', 'shotList', 'prompt']" />
      <el-button v-if="data.role === 'script'" text size="small" :icon="IconTable" :disabled="!outputs.text.value.trim() || generating" :title="translate('Create a text node connected to this script in which an uncensored model reads the whole script and writes its shot list')" @click="createShotList">{{ translate("Generate shot list") }}</el-button>
      <el-button v-if="data.role === 'prompt'" text size="small" :icon="IconArrowsSplit" :disabled="!outputs.text.value.trim()" :title="translate('Fill each generation node that belongs to a shot with the matching ### section of this text, such as ### Shot 3')" @click="distributePrompts">{{ translate("Distribute prompts") }}</el-button>
      <el-button v-if="data.role === 'shotList'" text size="small" :icon="IconCube3dSphere" :title="translate('Create a Director\'s Studio node that blocks this shot list in previs one shot at a time; each confirmed shot is exported as its layout for the keyframe')" @click="createPrevis">{{ translate("Create previs") }}</el-button>
      <el-button v-if="data.role === 'shotList'" text size="small" :icon="IconLayoutGridAdd" :title="translate('Create a keyframe node for each shot of this shot list, connected to the scene and character images, and a video node for each shot whose keyframe is generated')" @click="openShotNodes">{{ translate("Build shot nodes") }}</el-button>
      <el-button v-if="data.role === 'shotList'" text size="small" :icon="IconMovie" :loading="preparing" :disabled="generating" :title="translate('For every shot whose keyframe is generated, create its MiniMax H3 video node and have an uncensored model write its prompt; generation itself is not started')" @click="prepareVideos">{{ translate("Prepare videos") }}</el-button>
    </template>
    <div class="textContent" :class="{ empty: !outputs.text.value.trim() }">
      <el-alert v-if="documentState.error" :title="documentState.error" type="error" :closable="false" showIcon>
        <el-button text size="small" :disabled="generating || textReloading" @click="editing = true">查看并复制当前正文</el-button>
        <el-button text size="small" :disabled="generating" :loading="textReloading" @click="reloadText">重新读取磁盘</el-button>
      </el-alert>
      <div v-if="outputs.text.value.trim() && previewReady" class="textPreview nopan nowheel" aria-label="文本内容">
        <markdownPreview :modelValue="outputs.text.value" :files="textReady ? textFiles : undefined" :path="textPath" :active="previewReady" />
      </div>
      <el-button class="editButton nodrag nopan" :icon="IconEdit" :disabled="generating || !textReady" text @dblclick.stop @click.stop="editing = true">编辑</el-button>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <div class="promptHeader" v-if="refList.length">
          <referenceItem
            v-model="refList"
            @preview="setReferencePreview"
            @remove="removeReference" />
        </div>
        <promptInput v-model="promptModel" v-model:text="prompt" :references="referenceMentions" />
        <div class="promptFooter">
          <el-select v-model="model" class="modelSelect" filterable :loading="modelsLoading" :disabled="generating" placeholder="选择模型" aria-label="生成模型" noDataText="请先在设置中添加模型" placement="top-start" @visible-change="visible => visible && loadModels()">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <div class="promptActions">
            <el-button class="sendButton" :icon="IconArrowUp" :loading="generating" :disabled="!prompt.trim() || !selectedModel || generating || !textReady" title="生成" aria-label="生成" @click="generateText" />
          </div>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <el-dialog v-model="editing" title="编辑文本" width="min(860px, calc(100vw - 32px))" :fullscreen="fullscreen" alignCenter appendToBody @closed="fullscreen = false">
    <div class="textEditor" :class="{ fullscreen }">
      <markdownEditor v-model="outputs.text.value" :files="textReady ? textFiles : undefined" :path="textPath" :active="editing" :disabled="generating || textReloading" :readonly="!!documentState.error" ariaLabel="编辑文本内容" />
    </div>
  </el-dialog>
  <shotNodesDialog v-if="shotNodesPlan" :plan="shotNodesPlan" :loraRows="loraRows" @build="buildShotNodes" @closed="shotNodesPlan = undefined" />
  <el-dialog :modelValue="!!prepareRequest" :title="translate('Prepare videos')" width="min(520px, calc(100vw - 32px))" alignCenter appendToBody @close="answerPrepare()">
    <div class="prepareDialog">
      <p v-for="note in prepareRequest?.notes" :key="note">{{ note }}</p>
      <div class="prepareOption">
        <span>{{ translate("Video resolution") }}</span>
        <el-radio-group v-model="videoResolution" size="small">
          <el-radio-button v-for="item in videoResolutions" :key="item" :value="item">{{ item }}</el-radio-button>
        </el-radio-group>
      </div>
      <small>{{ translate("Higher resolutions take longer on Colab and use more credits; 1080p takes about 35 minutes per clip.") }}</small>
      <div class="prepareOption">
        <span>{{ translate("Aspect ratio") }}</span>
        <el-radio-group v-model="videoRatio" size="small">
          <el-radio-button value="">{{ translate("Same as keyframe") }}</el-radio-button>
          <el-radio-button v-for="item in videoRatios" :key="item" :value="item">{{ item }}</el-radio-button>
        </el-radio-group>
      </div>
      <small v-if="videoRatio">{{ translate("A ratio other than the keyframe's crops or pads its first frame.") }}</small>
      <p>{{ translate("Video generation is not started; review each prompt and start it yourself.") }}</p>
    </div>
    <template #footer>
      <el-button @click="answerPrepare()">{{ translate("Cancel") }}</el-button>
      <el-button type="primary" @click="answerPrepare({ resolution: videoResolution, ratio: videoRatio })">{{ translate("Prepare") }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { t, translate } from "@toonflow/i18n/vue";
import { computed, inject, onMounted, ref, watch } from "vue";
import { checkScript } from "@toonflow/node-shared/scriptCheck";
import { shotListFixPrompt, shotListInstructions } from "@toonflow/node-shared/shotListPrompt";
import { previsInstructions } from "@toonflow/node-shared/previsInstructions";
import { keyframeDescriptionInstructions, layoutLine, masterLine, stateLine, withoutFullStop } from "@toonflow/node-shared/keyframePrompt";
import { useVueFlow } from "@vue-flow/core";
import { flashNode } from "@toonflow/nodes-scaffold/flashNode";
import { planPromptDistribution } from "./distributePrompts";
import { planShotNodes, type ShotNodesPlan } from "./shotNodes";
import { castNames, shotSpans, templateForCast, type ShotSpan } from "@toonflow/node-shared/shotList";
import { fillDialogue, parseDialogue, speakerIds, videoPromptInstructions } from "@toonflow/node-shared/videoPrompt";
import { checkVideoPrompt, parseReview, passingScore, reviewInstructions, type VideoPreflight } from "./videoPreflight";
import shotNodesDialog, { type LoraRow, type ShotNodesChoice } from "./shotNodesDialog.vue";
import { ElAlert, ElButton, ElCard, ElSelect, ElDialog, ElOption, ElOptionGroup, ElMessage, ElMessageBox, ElRadioButton, ElRadioGroup } from "element-plus";
import { IconEdit, IconFileText, IconSparkles, IconArrowUp, IconArrowsSplit, IconLayoutGridAdd, IconTable, IconMovie, IconCube3dSphere } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, z, type NodeAiModel, type NodeHandle, type NodeLoraRecord } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import markdownEditor from "./markdownEditor.vue";
import markdownPreview from "./markdownPreview.vue";
import referenceItem from "@toonflow/node-shared/referenceItem";
import promptInput from "@toonflow/node-shared/promptInput";
import roleSelect from "@toonflow/node-shared/roleSelect";
import { roleOf, type NodeRoleData } from "@toonflow/node-shared/nodeRole";
import { listLoras, type AttachedLora } from "@toonflow/node-shared/loraRegistry";
import { useNodeDocumentState, type NodeDocumentContext } from "@toonflow/nodes-scaffold/nodeDocument";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;

defineOptions({
  inheritAttrs: false,
  icon: IconFileText,
  handles: [
    { id: "in", type: "target", dataType: ["VIDEO", "IMAGE", "STRING"], label: "视频、图片、文本输入" },
    { id: "text", type: "source", dataType: "STRING", label: "文本输出" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, ai, files, nodeEvent, previewReady } = useNode({
  label: "文本",
  outputs: { text: { dataType: "STRING", value: "" } },
});
const flow = useVueFlow();
const { refList, referenceMentions, setReferencePreview, removeReference, assertReferencesReady } = useNodeReferences();
const editing = ref(false);
const fullscreen = ref(false);
const downloadUrl = ref("");
const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
watch([() => outputs.value.text.value, () => node.selected || !!documentContext?.targets.has(node.id)], ([text, visible], _previous, onCleanup) => {
  downloadUrl.value = "";
  if (!visible || !text.trim()) return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  downloadUrl.value = url;
  onCleanup(() => URL.revokeObjectURL(url));
}, { immediate: true });
const data = computed(() => node.data as typeof node.data & { prompt?: string; promptModel?: PromptModel; model?: string; textPath?: string; textSnapshot?: string; generateOnLoad?: boolean; videoResolution?: string; videoRatio?: string } & NodeRoleData);
const prompt = computed({ get: () => data.value.prompt ?? "", set: (value: string) => { data.value.prompt = value; } });
const model = computed({ get: () => data.value.model ?? "", set: (value: string) => { data.value.model = value; } });
const models = ref<NodeAiModel[]>([]);
const modelsLoading = ref(false);
const generating = ref(false);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const modelGroups = computed(() => groupNodeModels(models.value));
const textReady = ref(false);
const textReloading = ref(false);
const textPath = `assets/${node.id}/content.md`;
let textFiles: ReturnType<typeof files.getWorkspaceFiles>;
let textLoading: Promise<void> | undefined;
let textSaving = Promise.resolve();
let textSnapshot: Awaited<ReturnType<typeof textFiles.readTextSnapshot>> | undefined;
let textRevision = 0;
const documentState = useNodeDocumentState();
function saveText(value: string) {
  const revision = ++textRevision;
  documentState.dirty = true;
  textSaving = textSaving.catch(() => {}).then(async () => {
    if (!textSnapshot) throw new Error("文本尚未加载，无法保存");
    textSnapshot.revision = await textFiles.writeTextSnapshot(textPath, value, textSnapshot);
    textSnapshot.text = value;
    if (revision === textRevision && outputs.value.text.value === value) {
      documentState.dirty = false;
      documentState.error = "";
    }
  }).catch(error => {
    documentState.error = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      || (error instanceof Error ? error.message : "文本保存失败");
    throw error;
  });
  return textSaving;
}
nodeEvent.on("save", async (reason) => {
  await textLoading;
  if (!textReady.value) throw new Error("文本尚未加载，无法保存");
  if (reason === "reload" && generating.value) throw new Error("文本正在生成，请完成后再刷新节点");
  // Regular edits are already queued by the watcher; during generation, also save the current chunk,
  // without rewriting unchanged text on canvas save.
  if (generating.value) saveText(outputs.value.text.value);
  let pending: Promise<void>;
  do {
    pending = textSaving;
    try { await pending; }
    catch { await saveText(outputs.value.text.value); }
  } while (pending !== textSaving);
  if (reason === "reload" && generating.value) throw new Error("文本正在生成，请完成后再刷新节点");
});
onMounted(() => { textLoading = loadText(); });
async function loadText(fromDisk = false) {
  textReloading.value = true;
  textReady.value = false;
  try {
    if (!node.id || /[\\/]/.test(node.id) || node.id === "." || node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
    if (data.value.textPath !== undefined && data.value.textPath !== textPath) throw new Error("文本文件路径无效");
    textFiles = files.getWorkspaceFiles();
    if (data.value.textPath || fromDisk) textSnapshot = await textFiles.readTextSnapshot(textPath);
    const value = fromDisk ? textSnapshot!.text : data.value.textSnapshot !== undefined ? data.value.textSnapshot : textSnapshot?.text ?? outputs.value.text.value;
    if (typeof value !== "string") throw new Error("文本内容无效");
    if (!data.value.textPath && !fromDisk) {
      for (const directory of ["assets", `assets/${node.id}`]) {
        await textFiles.mkdir(directory).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
          if (error.response?.data?.data?.code !== "EEXIST") throw error;
        });
      }
      await textFiles.write(textPath, value, true).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
      textSnapshot = await textFiles.readTextSnapshot(textPath);
      if (textSnapshot.text !== value) throw new Error("文本文件已被其他编辑器修改，请重新加载节点");
    } else if (textSnapshot && textSnapshot.text !== value) {
      textSnapshot.revision = await textFiles.writeTextSnapshot(textPath, value, textSnapshot);
      textSnapshot.text = value;
    }
    outputs.value.text.value = value;
    data.value.textPath = textPath;
    delete data.value.textSnapshot;
    // ACT: Drop the inline body only after it is persisted; if migration fails the canvas keeps the original content.
    if (!Object.hasOwn(outputs.value, "toJSON")) Object.defineProperty(outputs.value, "toJSON", { value: () => ({}) });
    textSaving = Promise.resolve();
    textReady.value = true;
    documentState.dirty = false;
    documentState.error = "";
  } catch (error) {
    documentState.error = (error as { response?: { data?: { message?: string } } })?.response?.data?.message
      || (error instanceof Error ? error.message : translate("文本加载失败"));
    ElMessage.error(documentState.error);
  } finally { textReloading.value = false; }
}

async function reloadText() {
  if (generating.value || textReloading.value) return;
  const confirmed = await ElMessageBox.confirm("重新读取将用磁盘内容替换当前正文。未保存的修改会被放弃，请先复制需要保留的内容。", "重新读取文本", {
    confirmButtonText: "重新读取", cancelButtonText: "取消", type: "warning", closeOnClickModal: false,
  }).then(() => true, () => false);
  if (!confirmed || generating.value || textReloading.value) return;
  const fromDisk = textReady.value || !!textSnapshot || !!data.value.textPath;
  textReloading.value = true;
  textReady.value = false;
  await textSaving.catch(() => {});
  textLoading = loadText(fromDisk);
  await textLoading;
}

watch(() => outputs.value.text.value, async (value) => {
  if (!textReady.value) return;
  documentState.dirty = true;
  if (generating.value) return;
  try { await saveText(value); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "文本保存失败"); }
}, { flush: "sync" });
nodeEvent.on("copy", () => {
  if (!textReady.value) throw new Error("文本尚未加载");
  return { textPath: undefined, textSnapshot: outputs.value.text.value };
});

onMounted(loadModels);

async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  try {
    models.value = await ai.getModels();
    if (!model.value) {
      const first = models.value[0];
      model.value = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  } catch (error) {
    if (error instanceof Error && error.name !== "AbortError") ElMessage.error(error.message);
  } finally {
    modelsLoading.value = false;
  }
}

async function generateText() {
  const choice = selectedModel.value;
  if (!textReady.value || generating.value || !choice || !prompt.value.trim()) return;
  generating.value = true;
  generationFailed.value = false;
  let text = "";
  try {
    assertReferencesReady();
    const references = refList.value
      .filter(item => item.value !== undefined && (item.dataType === "STRING" || item.dataType === "IMAGE" || item.dataType === "VIDEO"))
      .map(item => item.dataType === "STRING" ? { dataType: item.dataType, value: item.value } : { dataType: item.dataType, value: { ...item.value } });
    const input = { providerId: choice.providerId, modelId: choice.modelId, prompt: prompt.value.trim(), references };
    const directory = references.some(item => item.dataType !== "STRING") ? (await textFiles.list()).directory : undefined;
    const result = await ai.generate({
      ...input,
      directory,
      onEvent(event) {
        if (event.type === "text") outputs.value.text.value = text += event.delta;
      },
    });
    outputs.value.text.value = result.text;
    // A shot list made by "Generate shot list" passes the timing check as its last step: a failing list is rewritten
    // once with the problems found, and whatever still fails is reported.
    if (data.value.role === "shotList") {
      const problems = checkScript(result.text).issues;
      if (problems.length) {
        text = "";
        const fixed = await ai.generate({
          ...input,
          prompt: shotListFixPrompt(input.prompt, result.text, problems.map(issue => translate(issue))),
          directory,
          onEvent(event) {
            if (event.type === "text") outputs.value.text.value = text += event.delta;
          },
        });
        outputs.value.text.value = fixed.text;
      }
      reportShotListCheck();
    }
  } catch (error) {
    generationFailed.value = !(error instanceof Error && error.name === "AbortError");
    if (error instanceof Error && error.name !== "AbortError") ElMessage.error(error.message);
  } finally {
    // Unmounting aborts the request and stops the watcher, so generation cleanup must save the received body itself.
    try { await saveText(outputs.value.text.value); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : "文本保存失败"); }
    generating.value = false;
  }
}
const promptModel = computed({ get: () => data.value.promptModel ?? [], set: (value: PromptModel) => { data.value.promptModel = value; } });

// A shot list node created by "Generate shot list" starts its generation once its text and models are loaded; the
// flag is removed first, so reopening the canvas never generates again.
watch(() => textReady.value && !!selectedModel.value, ready => {
  if (!ready || !data.value.generateOnLoad) return;
  delete data.value.generateOnLoad;
  void generateText();
}, { immediate: true });

// ACT: Shot lists are written by this uncensored Colab model, the fastest one measured on the L4, so no scene of the
// script is refused or skipped. The whole script must fit its 32K context; longer scripts fail with the server's error.
const shotListModelId = "HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive";

/** Adds a text node to the right that reads this whole script and writes a shot list "Build shot nodes" can read. */
function createShotList() {
  if (!outputs.value.text.value.trim()) return;
  const shotListModel = models.value.find(item => item.modelId === shotListModelId);
  if (!shotListModel) return void ElMessage.warning(t`Add the Colab CLI provider with ${shotListModelId} in Settings first`);
  const script = "{{ref 1}}";
  // The cast column must use the names "Build shot nodes" matches against, the characters found on the canvas.
  // People, not outfits: what they wear or not goes in the State column.
  const names = [...new Set(planShotNodes(node.id, "", [], flow.getNodes.value, flow.getEdges.value, new Set()).characters.map(item => item.person))];
  const instructions = shotListInstructions(script, names).map(item => translate(item)).join("\n");
  const id = crypto.randomUUID();
  // Earlier shot lists of this script sit to its right, so a new one goes below the lowest node this script feeds.
  const fed = flow.getEdges.value.flatMap(edge => edge.source === node.id ? flow.findNode(edge.target) ?? [] : []);
  const y = fed.length ? Math.max(...fed.map(item => item.computedPosition.y + (item.dimensions.height || 240))) + 60 : node.computedPosition.y;
  flow.addNodes([{ id, type: "remote-textNode", position: {
    x: node.computedPosition.x + (node.dimensions.width || 320) + 120, y,
  }, data: {
    label: t`Shot list`, outputs: {}, prompt: instructions, promptModel: instructions.split("\n").map(text => [{ type: "Write", text }]),
    model: JSON.stringify([shotListModel.providerId, shotListModel.modelId]), referenceOrder: { in: [encodeURIComponent(JSON.stringify([node.id, "text"]))] }, generateOnLoad: true, role: "shotList",
  } }]);
  flow.addEdges([{ id: crypto.randomUUID(), source: node.id, sourceHandle: "text", target: id, targetHandle: "in" }]);
}

/**
 * Adds a Director's Studio node fed by this shot list (and the script feeding it) that blocks the shots one at a time:
 * it carries one instruction per shot, the first also building the set, and starts with the first shot's instruction.
 */
async function createPrevis() {
  const text = outputs.value.text.value;
  const { shots, issues } = checkScript(text);
  if (!shots.length) return void ElMessage.warning(translate(issues[0]!));
  const existing = flow.getEdges.value.some(edge => edge.source === node.id && flow.findNode(edge.target)?.type === "remote-director3dNode");
  if (existing) return void ElMessage.info(translate("This shot list already has a previs node; continue the shots there"));
  if (!models.value.length) await loadModels();
  const writer = models.value.find(item => item.modelId === shotListModelId);
  if (!writer) return void ElMessage.warning(t`Add the Colab CLI provider with ${shotListModelId} in Settings first`);
  const spans = shotSpans(shots, text);
  const scripts = planShotNodes(node.id, text, spans, flow.getNodes.value, flow.getEdges.value, new Set()).scripts.map(item => item.nodeId);
  const sources = [...scripts, node.id];
  const queue = previsInstructions(spans, scripts.length).map(item => ({ shot: item.shot, instruction: item.lines.map(line => typeof line === "string" ? line : translate(line)).join("\n") }));
  const id = crypto.randomUUID();
  const first = queue[0]!.instruction;
  flow.addNodes([{ id, type: "remote-director3dNode", position: {
    x: node.computedPosition.x + (node.dimensions.width || 320) + 120, y: node.computedPosition.y,
  }, data: {
    label: translate("Previs"), outputs: {}, prompt: first, promptModel: first.split("\n").map(line => [{ type: "Write", text: line }]),
    model: JSON.stringify([writer.providerId, writer.modelId]), referenceOrder: { in: sources.map(source => encodeURIComponent(JSON.stringify([source, "text"]))) },
    previs: { shots: queue, done: [] },
  } }]);
  flow.addEdges(sources.map(source => ({ id: crypto.randomUUID(), source, sourceHandle: "text", target: id, targetHandle: "in" })));
  ElMessage.success(translate("Previs node created: open it and block the shots one at a time"));
}

/** Shows the timing check of the generated shot list: a short note when it passes, the problems when it does not. */
function reportShotListCheck() {
  const { shots, total, median, issues } = checkScript(outputs.value.text.value);
  const summary = t`${shots.length} shots, ${total.toFixed(2)} s in total, median shot ${median.toFixed(2)} s.`;
  if (!issues.length) return void ElMessage.success(summary);
  const details = issues.map(issue => translate(issue)).join("\n");
  void ElMessageBox.alert(`${summary}\n\n${details}`, translate("Shot list check"), {
    type: "warning", customStyle: { whiteSpace: "pre-line", maxWidth: "640px" },
  }).catch(() => {});
}

async function distributePrompts() {
  const plan = planPromptDistribution(outputs.value.text.value, flow.getNodes.value, flow.getEdges.value);
  const shots = (list: number[]) => list.join(", ");
  const notes = [
    plan.missingNodes.length ? t`No generation node belongs to shot ${shots(plan.missingNodes)}.` : "",
    plan.duplicateNodes.length ? t`Several nodes belong to shot ${shots(plan.duplicateNodes)}; give each of them a different shot.` : "",
    plan.emptyShots.length ? t`Shot ${shots(plan.emptyShots)} has an empty section.` : "",
  ].filter(Boolean);
  if (!plan.assignments.length) {
    void ElMessageBox.alert([translate("No ### shot section matches a generation node."), ...notes].join("\n"), translate("Distribute prompts"), { type: "warning", customStyle: { whiteSpace: "pre-line" } });
    return;
  }
  const removed = plan.assignments.reduce((sum, item) => sum + item.removedEdgeIds.length, 0);
  const summary = t`Replace the prompts of ${plan.assignments.length} nodes (shots ${shots(plan.assignments.map(item => item.shot))}) and disconnect ${removed} references they do not name?`;
  if (!await ElMessageBox.confirm([summary, ...notes].join("\n"), translate("Distribute prompts"), {
    confirmButtonText: translate("Distribute"), cancelButtonText: translate("Cancel"), type: "info", customStyle: { whiteSpace: "pre-line" },
  }).then(() => true, () => false)) return;
  for (const item of plan.assignments) {
    const target = flow.findNode(item.nodeId);
    if (!target) continue;
    target.data = {
      ...target.data, prompt: item.prompt, promptModel: item.prompt.split("\n").map(text => [{ type: "Write", text }]),
      referenceOrder: { ...target.data.referenceOrder, in: item.referenceOrder }, shotText: item.shotText,
    };
  }
  flow.removeEdges(plan.assignments.flatMap(item => item.removedEdgeIds));
  // Show where the prompts went: bring the source and the filled nodes into view and ripple each filled node.
  const filled = plan.assignments.flatMap(item => flow.findNode(item.nodeId) ?? []);
  for (const target of filled) flashNode(target.data, translate("Prompt filled"));
  flashNode(node.data, translate("Prompts distributed"));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reducedMotion ? 0 : 600;
  const original = { ...flow.viewport.value };
  // Never zoom in past the current scale, and return to the original view once the flash ends unless the user has
  // moved the canvas meanwhile.
  void flow.fitView({ nodes: [node.id, ...filled.map(item => item.id)], padding: 0.3, maxZoom: original.zoom, duration }).then(() => {
    const focused = { ...flow.viewport.value };
    setTimeout(() => {
      const current = flow.viewport.value;
      if (current.x === focused.x && current.y === focused.y && current.zoom === focused.zoom) void flow.setViewport(original, { duration });
    }, 2400);
  });
  ElMessage.success(t`Filled ${plan.assignments.length} nodes`);
}

// The node frame blinks yellow while generating, turns red when the last generation failed and green once it holds text.
const generationFailed = ref(false);
const preparing = ref(false);
const generationStatus = computed(() => generating.value || preparing.value ? "running" : generationFailed.value ? "failed" : outputs.value.text.value.trim() ? "succeeded" : "idle");
const shotNodesPlan = ref<ShotNodesPlan>();

// ACT: Videos are prepared for MiniMax H3 on Colab, the video model of this pipeline; its first-frame mode is stored as
// "endFrameOptional" (the end frame is optional). Another video model would need its own prompt format.
const h3Model = JSON.stringify(["minimaxH3", "minimax_h3_ref2va"]);
const videoResolutions = ["480p", "720p", "1080p"];
// The resolution chosen for this shot list's videos; 1080p unless the user picked another one before.
const videoResolution = computed({ get: () => data.value.videoResolution ?? "1080p", set: (value: string) => { data.value.videoResolution = value; } });
const videoRatios = ["16:9", "9:16", "1:1", "4:3", "3:4"];
// An empty ratio keeps each video at its keyframe's ratio.
const videoRatio = computed({ get: () => data.value.videoRatio ?? "", set: (value: string) => { data.value.videoRatio = value; } });
const prepareRequest = ref<{ notes: string[]; resolve: (choice?: { resolution: string; ratio: string }) => void }>();

/** Shows what "Prepare videos" will do and resolves with the chosen resolution and ratio, or undefined when cancelled. */
function askPrepare(notes: string[]) {
  return new Promise<{ resolution: string; ratio: string } | undefined>(resolve => { prepareRequest.value = { notes, resolve }; });
}

function answerPrepare(choice?: { resolution: string; ratio: string }) {
  const request = prepareRequest.value;
  prepareRequest.value = undefined;
  request?.resolve(choice);
}

/**
 * Takes every shot whose keyframe is generated to a ready-to-run video node: creates its MiniMax H3 node starting from
 * that keyframe when missing, then has the shot list model write the H3 prompt from the whole script and shot list.
 * Video nodes that already hold a written prompt keep it and only take the chosen quality and ratio; no video
 * generation is started.
 */
async function prepareVideos() {
  if (preparing.value || generating.value) return;
  const text = outputs.value.text.value;
  const spans = shotSpans(checkScript(text).shots, text);
  const plan = planShotNodes(node.id, text, spans, flow.getNodes.value, flow.getEdges.value, new Set());
  if (!models.value.length) await loadModels();
  const writer = models.value.find(item => item.modelId === shotListModelId);
  if (!writer) return void ElMessage.warning(t`Add the Colab CLI provider with ${shotListModelId} in Settings first`);
  if (!(await ai.getMediaModels()).some(item => JSON.stringify([item.providerId, item.modelId]) === h3Model)) {
    return void ElMessage.warning(translate("Add the MiniMax H3 (Colab) media provider in Settings first"));
  }
  const unwritten = (shot: number) => {
    const prompt = String(flow.findNode(plan.videos.get(shot)!)?.data?.prompt ?? "");
    return !prompt.trim() || prompt.includes("{{shot}}");
  };
  const create = spans.filter(span => plan.generatedKeyframes.has(span.shot) && !plan.videos.has(span.shot));
  const fill = spans.filter(span => plan.generatedKeyframes.has(span.shot) && plan.videos.has(span.shot) && unwritten(span.shot));
  const waiting = spans.filter(span => !plan.generatedKeyframes.has(span.shot)).map(span => span.shot);
  const existing = spans.filter(span => plan.videos.has(span.shot));
  const shots = (list: { shot: number }[]) => list.map(item => item.shot).join(", ");
  // Trained MiniMax H3 LoRAs of the people named in a shot's cast cell.
  loraRecords.value = await listLoras(files.getWorkspaceFiles()).catch(() => []);
  const lorasOf = (span: ShotSpan) => characterLoras(castNames(span), "h3");
  const notes = [
    !create.length && !fill.length ? translate("Every shot with a generated keyframe already has a video node with a written prompt.") : "",
    existing.length ? t`The chosen quality and ratio also apply to the existing video nodes of shots ${shots(existing)}.` : "",
    create.length ? t`Create MiniMax H3 video nodes for shots ${shots(create)}, each starting from its keyframe.` : "",
    create.length + fill.length ? t`Write and preflight the video prompts of shots ${shots([...create, ...fill].sort((a, b) => a.shot - b.shot))} with ${writer.label}, one after another; a prompt scoring under ${passingScore} is rewritten once.` : "",
    waiting.length ? t`Shots ${waiting.join(", ")} wait for their keyframes.` : "",
  ].filter(Boolean);
  const choice = await askPrepare(notes);
  if (!choice) return;
  const { resolution } = choice;
  // Existing video nodes, written or not, take the chosen settings; an empty ratio leaves each one's ratio alone.
  for (const span of existing) {
    const target = flow.findNode(plan.videos.get(span.shot)!);
    if (target) target.data = { ...target.data, resolution, ...choice.ratio ? { ratio: choice.ratio } : {} };
  }
  if (!create.length && !fill.length) return void ElMessage.success(t`Set shots ${shots(existing)} to ${resolution}`);

  preparing.value = true;
  try {
    // New video nodes sit to the right of their keyframes and start from them in H3's first-frame mode.
    flow.addNodes(create.map(span => {
      const keyframe = flow.findNode(plan.keyframes.get(span.shot)!)!;
      const time = `${Number(span.start.toFixed(2))}–${Number(span.end.toFixed(2))}s`;
      return { id: crypto.randomUUID(), type: "remote-videoGenerationNode", position: {
        x: keyframe.computedPosition.x + (keyframe.dimensions.width || 320) + 80, y: keyframe.computedPosition.y,
      }, data: {
        label: t`Shot ${span.shot} video (${time})`, outputs: {}, shot: span.shot, prompt: "", promptModel: [],
        model: h3Model, mode: JSON.stringify("endFrameOptional"), duration: Math.max(4, Math.ceil(span.end - span.start)), resolution,
        ratio: choice.ratio || String(keyframe.data?.ratio ?? "16:9"), referenceOrder: { in: [encodeURIComponent(JSON.stringify([keyframe.id, "image"]))] },
      } };
    }));
    const created = planShotNodes(node.id, text, spans, flow.getNodes.value, flow.getEdges.value, new Set()).videos;
    flow.addEdges(create.map(span => ({
      id: crypto.randomUUID(), source: plan.keyframes.get(span.shot)!, sourceHandle: "image", target: created.get(span.shot)!, targetHandle: "in",
    })));
    // Each shot's previs video joins its video node after the keyframe, so the prompt names it <Video 1>.
    for (const span of [...create, ...fill]) {
      const previs = plan.previsVideos.get(span.shot);
      const target = flow.findNode(created.get(span.shot)!);
      if (!previs || !target || flow.getEdges.value.some(edge => edge.source === previs && edge.target === target.id)) continue;
      const key = encodeURIComponent(JSON.stringify([previs, "video"]));
      target.data = { ...target.data, referenceOrder: { ...target.data?.referenceOrder, in: [...target.data?.referenceOrder?.in ?? [], key] } };
      flow.addEdges([{ id: crypto.randomUUID(), source: previs, sourceHandle: "video", target: target.id, targetHandle: "in" }]);
    }
    const scripts = plan.scripts.map(item => ({ dataType: "STRING" as const, value: String(flow.findNode(item.nodeId)?.data?.outputs?.text?.value ?? "") }));
    const references = [...scripts, { dataType: "STRING" as const, value: text }];
    const ids = speakerIds(spans);
    const reports: string[] = [];
    let failed = false;
    for (const span of [...create, ...fill].sort((a, b) => a.shot - b.shot)) {
      const target = flow.findNode(created.get(span.shot)!);
      if (!target) continue;
      const duration = Number(target.data?.duration ?? Math.ceil(span.end - span.start));
      const order = spans.indexOf(span);
      const ask = async (prompt: string) => (await ai.generate({ providerId: writer.providerId, modelId: writer.modelId, prompt, references })).text.trim();
      // Writes a prompt and preflights it: the checks that need no model first, then the Gate 1 review by the writer.
      const attempt = async (feedback?: { draft: string; issues: string[] }) => {
        const instructions = videoPromptInstructions(span, scripts.length, { duration, previs: plan.previsVideos.has(span.shot), loras: lorasOf(span) }, ids);
        const draft = await ask(feedback
          ? `${instructions}\n\nYour previous draft, with dialogue markers:\n${feedback.draft}\n\nFix these problems and output the whole prompt again:\n${feedback.issues.map(issue => `- ${issue}`).join("\n")}`
          : instructions);
        let prompt = draft;
        try {
          prompt = fillDialogue(draft, parseDialogue(span.dialogue));
        } catch (error) {
          return { draft, prompt, score: 0, issues: [t`Dialogue markers are misplaced (${error instanceof Error ? error.message : ""}).`] };
        }
        const issues = checkVideoPrompt(prompt, span, duration, plan.previsVideos.has(span.shot), lorasOf(span).map(lora => lora.trigger));
        if (issues.length) return { draft, prompt, score: 0, issues };
        try {
          const review = parseReview(await ask(reviewInstructions(span, scripts.length, duration, prompt, spans[order - 1], spans[order + 1], plan.previsVideos.has(span.shot))));
          return { draft, prompt, ...review };
        } catch {
          return { draft, prompt, score: 0, issues: [translate("The review did not return a valid score.")] };
        }
      };
      let result = await attempt();
      // One rewrite with the findings; a shot that still fails is filled in and marked for the user to decide.
      if (result.score < passingScore) result = await attempt({ draft: result.draft, issues: result.issues });
      const preflight: VideoPreflight = { prompt: result.prompt, score: result.score, issues: result.issues, passed: result.score >= passingScore };
      // The video node loads the trained LoRAs of the shot's cast; the prompt names each by its trigger word.
      target.data = { ...target.data, loras: lorasOf(span), prompt: result.prompt, promptModel: result.prompt.split("\n").map(line => [{ type: "Write", text: line }]), preflight };
      failed ||= result.score < passingScore;
      flashNode(target.data, result.score >= passingScore ? translate("Prompt filled and preflighted") : translate("Preflight failed"));
      reports.push([
        result.score >= passingScore ? t`Shot ${span.shot}: passed, ${result.score}/100` : t`Shot ${span.shot}: needs attention, ${result.score}/100`,
        ...result.issues.map(issue => `  - ${issue}`),
      ].join("\n"));
    }
    void ElMessageBox.alert([...reports, "", translate("Video generation is not started; review each prompt and start it yourself.")].join("\n"), translate("Preflight report"), {
      type: failed ? "warning" : "success", customStyle: { whiteSpace: "pre-line", maxWidth: "640px" },
    }).catch(() => {});
  } catch (error) {
    if (!(error instanceof Error && error.name === "AbortError")) ElMessage.error(error instanceof Error ? error.message : translate("Failed to prepare the videos"));
  } finally {
    preparing.value = false;
  }
}

// Trained LoRAs of the workspace, read when a shot flow starts; character LoRAs are named after the person.
const loraRecords = ref<NodeLoraRecord[]>([]);
const characterLoras = (people: string[], family: NodeLoraRecord["family"]): AttachedLora[] => {
  const found = new Map<string, AttachedLora>();
  for (const record of loraRecords.value) {
    if (record.kind === "character" && record.family === family && people.includes(record.name) && !found.has(record.name)) {
      found.set(record.name, { path: record.path, trigger: record.trigger, name: record.name, kind: record.kind, family: record.family, strength: 1 });
    }
  }
  return [...found.values()];
};
// Scene LoRAs are named after the place, as typed on the scene images' role.
const sceneLoras = (sceneIds: string[]): AttachedLora[] => {
  const names = sceneIds.map(id => String(flow.findNode(id)?.data?.scene ?? "").trim()).filter(Boolean);
  return names.flatMap(name => {
    const record = loraRecords.value.find(item => item.kind === "scene" && item.family === "qwen" && item.name === name);
    return record ? [{ path: record.path, trigger: record.trigger, name: record.name, kind: record.kind, family: record.family, strength: 1 }] : [];
  });
};
// Which people and places of the shot list have trained LoRAs, shown in the dialog so missing ones can be trained first.
const hasLora = (kind: NodeLoraRecord["kind"], family: NodeLoraRecord["family"], name: string) =>
  loraRecords.value.some(record => record.kind === kind && record.family === family && record.name === name);
const loraRows = computed<LoraRow[]>(() => {
  const plan = shotNodesPlan.value;
  if (!plan) return [];
  const people = [...new Set(plan.characters.map(item => item.person))]
    .map(person => ({ label: person, video: hasLora("character", "h3", person), keyframe: hasLora("character", "qwen", person) }));
  const places = plan.scenes.map(item => {
    const name = String(flow.findNode(item.nodeId)?.data?.scene ?? "").trim();
    return { label: name || item.label, unnamed: !name, keyframe: !!name && hasLora("scene", "qwen", name) };
  });
  return [...people, ...places];
});

async function openShotNodes() {
  const { shots, issues } = checkScript(outputs.value.text.value);
  if (!shots.length) return void ElMessage.warning(translate(issues[0]!));
  loraRecords.value = await listLoras(files.getWorkspaceFiles()).catch(() => []);
  shotNodesPlan.value = planShotNodes(node.id, outputs.value.text.value, shotSpans(shots, outputs.value.text.value), flow.getNodes.value, flow.getEdges.value, new Set(flow.getSelectedNodes.value.map(item => item.id)));
}

/** The model most shot nodes of a type already use, so new nodes need no picking; depth control is never the default. */
function commonModel(type: string) {
  const counts = new Map<string, number>();
  for (const item of flow.getNodes.value) {
    const model = item.type === type ? String(item.data?.model ?? "") : "";
    if (model && !/depth/i.test(model)) counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

// A state cell that ends its own sentence would otherwise end with two full stops inside the template sentence.

function buildShotNodes(choice: ShotNodesChoice) {
  const plan = shotNodesPlan.value;
  if (!plan) return;
  const lines = (text: string) => text.split("\n").map(line => [{ type: "Write", text: line }]);
  const seconds = (value: number) => Number(value.toFixed(2));
  const references = [...choice.scenes, ...choice.characters.flatMap(item => item.cells)];
  const referenceKey = (id: string) => encodeURIComponent(JSON.stringify([id, "image"]));
  const keyframeModel = commonModel("remote-imageGenerationNode");
  const videoModel = commonModel("remote-videoGenerationNode");
  // Each shot gets a keyframe node first and its video node once its own keyframe is generated.
  const items = [...plan.keyframesToBuild.map(span => ({ span, video: false })), ...plan.videosToBuild.map(span => ({ span, video: true }))];
  // New nodes go to the right of everything on the canvas, a text node beside each shot node when requested.
  const left = Math.max(...flow.getNodes.value.map(item => item.computedPosition.x + (item.dimensions.width || 320))) + 400;
  const top = node.computedPosition.y;
  const columns = choice.textNodes ? 2 : 4;
  const newNodes: Parameters<typeof flow.addNodes>[0] = [];
  const newEdges: Parameters<typeof flow.addEdges>[0] = [];
  // Ids are fixed up front so every other shot can reference a master shot built in this same pass.
  const newIds = new Map(plan.keyframesToBuild.map(span => [span.shot, crypto.randomUUID()]));
  const masterId = !choice.masterShot ? undefined : newIds.get(choice.masterShot) ?? plan.keyframes.get(choice.masterShot);
  items.forEach(({ span, video }, index) => {
    const type = video ? "remote-videoGenerationNode" : "remote-imageGenerationNode";
    const generationModel = video ? videoModel : keyframeModel;
    const time = `${seconds(span.start)}–${seconds(span.end)}s`;
    const x = left + (index % columns) * (choice.textNodes ? 940 : 480);
    const y = top + Math.floor(index / columns) * 420;
    const id = video ? crypto.randomUUID() : newIds.get(span.shot)!;
    const keyframe = plan.keyframes.get(span.shot);
    // Only the shot's own cast is connected and named in its template; the text model cannot change it.
    const castIndexes = choice.cast[span.shot] ?? choice.characters.map((_, index) => index);
    const cast = castIndexes.map(index => choice.characters[index]!);
    const sources = video ? (keyframe ? [keyframe] : []) : [...choice.scenes, ...cast.flatMap(item => item.cells)];
    const castTemplate = video ? choice.videoTemplate : templateForCast(choice.template, references, sources, choice.characters.filter((_, index) => !castIndexes.includes(index)).map(item => item.name));
    // The shot list's character state is fixed text next to the shot description, so a text model cannot change it.
    const stateText = span.state ? translate(stateLine(span.state)) : "";
    // The previs layout and the master shot come after the template's references, so its numbering stays as written.
    const layout = video ? undefined : plan.layouts.get(span.shot);
    if (layout) sources.push(layout);
    const layoutText = layout ? translate(layoutLine(`{{ref ${sources.length}}}`)) : "";
    // Where people stand, measured in the previs scene when the shot was confirmed, is fixed text like the state line.
    const blocking = String(plan.layouts.has(span.shot) ? flow.findNode(plan.layouts.get(span.shot)!)?.data?.blocking ?? "" : "");
    const blockingLine = blocking && !video ? t`Previs blocking at the start of this shot: ${blocking}.` : "";
    const master = !video && masterId && masterId !== id ? masterId : undefined;
    if (master) sources.push(master);
    const masterText = master ? translate(masterLine(`{{ref ${sources.length}}}`)) : "";
    // A video node also takes the shot's previs video, after its keyframe, for blocking only.
    const previsVideo = video ? plan.previsVideos.get(span.shot) : undefined;
    const previsLine = previsVideo ? t`${`{{ref ${sources.length + 1}}}`} is this shot's grey-box previs: use it only for where each person stands and moves, their relative positions, timing and the camera move; take no shapes, materials, colours, set dressing or markings from it. People and the set look exactly like ${"{{ref 1}}"}.` : "";
    const fixedLines = [stateText, blockingLine, layoutText, masterText, previsLine].filter(Boolean).join("\n");
    const prompt = fixedLines && castTemplate.includes("{{shot}}") ? castTemplate.replace("{{shot}}", `${fixedLines}\n{{shot}}`) : castTemplate;
    newNodes.push({ id, type, position: { x: choice.textNodes ? x + 460 : x, y }, data: {
      label: video ? t`Shot ${span.shot} video (${time})` : t`Shot ${span.shot} keyframe (${time})`, outputs: {}, shot: span.shot,
      // Trained LoRAs of the shot's cast, and for keyframes of its scenes, load with the generation; the node adds their
      // trigger words to the prompt. ACT: A generation loads at most 4, so a crowded shot keeps the people and drops the
      // scene LoRA; raise the runners' limit if casts of four with a scene LoRA become common.
      ...(video ? { loras: characterLoras([...new Set(cast.map(item => item.person))], "h3") } : { role: "keyframe", loras: [...characterLoras([...new Set(cast.map(item => item.person))], "qwen"), ...sceneLoras(choice.scenes)].slice(0, 4) }),
      prompt, promptModel: lines(prompt), ratio: "16:9",
      referenceOrder: { in: [...sources.map(referenceKey), ...previsVideo ? [encodeURIComponent(JSON.stringify([previsVideo, "video"]))] : []] },
      ...(generationModel ? { model: generationModel } : {}), ...(video ? { duration: Math.ceil(span.end - span.start) } : {}),
    } });
    for (const source of sources) newEdges.push({ id: crypto.randomUUID(), source, sourceHandle: "image", target: id, targetHandle: "in" });
    if (previsVideo) newEdges.push({ id: crypto.randomUUID(), source: previsVideo, sourceHandle: "video", target: id, targetHandle: "in" });
    if (!choice.textNodes) return;
    const textId = crypto.randomUUID();
    const names = [...new Set(cast.map(item => item.person))];
    // With an original script upstream, each shot's text node reads it first and the shot list second.
    const textSources = [...plan.scripts.map(item => item.nodeId), node.id];
    const scriptRefs = plan.scripts.map((_, refIndex) => `{{ref ${refIndex + 1}}}`).join(", ");
    const instructions = [
      ...(plan.scripts.length ? [t`${scriptRefs} is the original script: use it for the story, each person's intentions and continuity. ${`{{ref ${textSources.length}}}`} is the shot list; describe the shot from it and add detail from the script.`] : []),
      ...video ? [
        t`Write the motion of shot ${span.shot} (${time}) of the attached shot list as one paragraph of 100 to 200 words: what each person does from the first frame, how the camera moves, and the sounds of the scene (dialogue, footsteps, ambience) without any music. Do not write reference markers, the setting, anyone's appearance or style words.`,
        t`Name people as the shot list does.`,
        ...blocking ? [t`The previs fixes the opening frame: ${blocking}. Place each person and the camera to match it.`] : [],
        span.state ? t`At the start of this shot the character state is: ${withoutFullStop(span.state)}. Posture and what each person holds must match it.`
          : translate("Read the earlier rows too: unless this row says otherwise, each person keeps the posture (sitting, standing, lying) and what they hold from the previous shots."),
        t`Output only the heading line "### Shot ${span.shot}" followed by the paragraph.`,
      ] : keyframeDescriptionInstructions(span.shot, time, names, span.state, blocking || undefined).map(item => translate(item)),
    ].join("\n");
    newNodes.push({ id: textId, type: "remote-textNode", position: { x, y }, data: {
      label: t`Shot ${span.shot} prompt`, outputs: {}, role: "prompt", prompt: instructions, promptModel: lines(instructions), model: data.value.model,
      referenceOrder: { in: textSources.map(source => encodeURIComponent(JSON.stringify([source, "text"]))) },
    } });
    for (const source of textSources) newEdges.push({ id: crypto.randomUUID(), source, sourceHandle: "text", target: textId, targetHandle: "in" });
  });
  flow.addNodes(newNodes);
  flow.addEdges(newEdges);
  ElMessage.success(t`Created ${items.length} shot nodes`);
}

nodeTools.register({
  name: "checkScript",
  description: "Check the shot list of this script: shot count, total and median length, shots over 8 s, gaps or overlaps between time ranges, and an optional target total length in seconds",
  parameters: z.strictObject({ target: z.number().positive().max(36000).optional() }),
  async execute({ target }) {
    if (!textReady.value) throw new Error("文本尚未加载");
    const result = checkScript(outputs.value.text.value, target);
    return { ...result, issues: result.issues.map(issue => translate(issue)) };
  },
});

nodeTools.register({
  name: "setText",
  description: "Modify this node's text output",
  parameters: z.strictObject({ text: z.string() }),
  async execute({ text }) {
    if (!textReady.value) throw new Error("文本尚未加载");
    if (generating.value) throw new Error("文本生成中，请稍后修改");
    if (outputs.value.text.value === text) await saveText(text);
    else { outputs.value.text.value = text; await textSaving; }
    return { text };
  },
});
</script>

<style lang="scss" scoped>
.textEditor {
  height: min(560px, calc(100dvh - 144px));
  min-height: 0;

  &.fullscreen {
    height: calc(100dvh - 112px);
  }
}

.prepareDialog {
  p {
    margin: 0 0 8px;
  }

  small {
    display: block;
    margin: 4px 0 10px;
    color: var(--el-text-color-secondary);
  }

  .prepareOption {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
}

.textContent {
  min-height: 110px;

  &.empty {
    display: flex;
    align-items: center;
    justify-content: center;

    .editButton {
      margin: 0;
    }
  }

  .textPreview {
    min-height: 110px;
    max-height: 240px;
    overflow: auto;
    overflow-wrap: anywhere;
    user-select: none;
  }

  .editButton {
    display: flex;
    margin-left: auto;
  }
}

.promptCard {
  .promptHeader {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;

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

    .promptActions {
      display: flex;
      align-items: center;
      gap: 12px;

      .toolButton {
        width: 28px;
        height: 28px;
        padding: 0;
      }

      .generationCount {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }

      .sendButton {
        width: 32px;
        height: 32px;
        margin: 0;
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
}
</style>
