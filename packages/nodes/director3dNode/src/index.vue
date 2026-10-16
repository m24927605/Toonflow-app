<template>
  <nodeSkeleton v-bind="nodeProps" style="width: 320px">
    <button v-loading="modelLoading" type="button" class="directorContent nopan" :disabled="modelLoading" :title="modelError || undefined" aria-label="打开导演台" @dblclick.stop @click.stop="openEditor">
      <img v-if="preview" class="scenePreview" :src="preview" alt="最后镜头" draggable="false" />
      <div v-else class="emptyPreview">
        <icon-cube3d-sphere :size="38" stroke="1.2" />
      </div>
    </button>
  </nodeSkeleton>
  <sceneEditor v-if="editing" v-model:anchors="anchors" v-model:prompt="prompt" v-model:model="model" v-model:allowMannequins="allowMannequins" :previsStep="previsStep" @previsStep="stepPrevis" v-model:lighting="lighting" v-model:sceneSettings="sceneSettings"
    :scene="scene" :result="selectedPlan" :models="models" :modelsLoading="modelsLoading" :addingMannequin="addingMannequin"
    :plans="plans" :selectedPlanId="data.selectedPlanId ?? ''" :tasks="tasks"
    :exportingVideo="exportingVideo" :exportingImage="exportingImage" :exportProgress="exportProgress"
    @exportVideo="exportVideo" @exportImage="exportImage" @addMannequin="addMannequin" @addTurnaround="addTurnaround"
    @selectPlan="data.selectedPlanId = $event" @loadModels="loadModels" @generate="generate" @editInstruction="setPrompt" @close="editing = false">
    <template #input>
      <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
      <promptInput v-model="promptModel" v-model:text="prompt" :references="referenceMentions" />
    </template>
  </sceneEditor>
</template>

<script setup lang="ts">
import { describeBlocking } from "./blocking";
import type { NodeRole } from "@toonflow/node-shared/nodeRole";
import { t, translate } from "@toonflow/i18n/vue";
import { computed, h, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { IconCube3dSphere } from "@tabler/icons-vue";
import { ElLoading, ElMessage, ElMessageBox } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, useNodeFiles, z, type NodeHandle, type NodeData, type NodeAiModel } from "@toonflow/nodes-scaffold/runtime";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import sceneEditor from "./sceneEditor.vue";
import { capturePreview, sceneSchema, createEmptyScene, createMannequinObject, createStage, createTurnaround, disposeStage, getSceneLighting, type LightingSettings, type SceneDocument, type SceneSettings } from "./scene";
import { planPrevis, planShot, renderPrevis } from "./previsRunner";
import { anchorSchema, prepareMotion, sampleMotion, type CameraAnchor } from "./motion";
import { directorPlanSchema, prepareSceneAnimation, type DirectorPlan, type DirectorGeneration } from "./sceneAnimation";
import { renderImage, renderVideo, type RenderPass } from "./renderMedia";
import { reviewPlan, type PlanIssue } from "./planReview";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const modelDocumentSchema = z.strictObject({
  version: z.literal(1),
  scene: sceneSchema,
  plans: z.array(directorPlanSchema.safeExtend({ id: z.string().min(1), instruction: z.string().optional() })),
});
type ModelDocument = z.infer<typeof modelDocumentSchema>;
defineOptions({
  inheritAttrs: false,
  icon: IconCube3dSphere,
  // The headless previs runner of auto production loads this plugin and calls these, without a canvas.
  planPrevis,
  renderPrevis,
  handles: [{ id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO"], label: "文本、图片、视频输入" }] satisfies NodeHandle[],
});
const { node, nodeProps, previewReady, ai, files, nodeEvent } = useNode({ label: "3D导演台" });
const vLoading = ElLoading.directive;
const { addNodes, findNode, getNodes, nodeTypes, removeNodes } = useVueFlow();
const mediaFiles = useNodeFiles();
const exportingVideo = ref(false);
const exportingImage = ref("");
const exportProgress = ref(0);
const exportController = new AbortController();
nodeEvent.on("delete", () => { if (exportingVideo.value || exportingImage.value) throw new Error("正在导出，请完成后再删除导演节点"); });
const data = computed(() => node.data as typeof node.data & {
  modelPath?: string;
  modelSnapshot?: ModelDocument;
  lighting?: LightingSettings;
  sceneSettings?: SceneSettings;
  prompt?: string;
  promptModel?: PromptModel;
  model?: string;
  allowMannequins?: boolean;
  previs?: PrevisQueue;
  anchors?: CameraAnchor[];
  selectedPlanId?: string;
});
const { refList, referenceMentions, setReferencePreview, removeReference, assertReferencesReady } = useNodeReferences();
const promptModel = computed({ get: () => data.value.promptModel ?? [], set: (value: PromptModel) => { data.value.promptModel = value; } });
const anchors = computed({ get: () => data.value.anchors ?? [], set: (value: CameraAnchor[]) => { data.value.anchors = value; } });
const prompt = computed({ get: () => data.value.prompt ?? "", set: (value: string) => { data.value.prompt = value; } });
const model = computed({ get: () => data.value.model ?? "", set: (value: string) => { data.value.model = value; } });
/**
 * A shot list's previs, blocked one shot at a time: `shots` holds each shot's instruction, written by the shot list;
 * `current` is the shot whose plan was just generated and awaits the user's check, and `done` lists the confirmed shots,
 * each exported as that shot's layout image.
 */
type PrevisQueue = { shots: { shot: number; instruction: string }[]; done: number[]; current?: number };
const previsStep = computed(() => {
  const queue = data.value.previs;
  const next = queue?.shots.find(item => !queue.done.includes(item.shot));
  if (!queue || !next) return undefined;
  const last = queue.shots.filter(item => !queue.done.includes(item.shot)).length === 1;
  // The shot's own generation, matched by its instruction, so the bar can say it is running or why it failed.
  const own = tasks.value.filter(task => task.instruction === next.instruction);
  const running = own.some(task => !task.error);
  const error = running ? undefined : own.findLast(task => task.error)?.error;
  return { shot: next.shot, total: queue.shots.length, confirm: queue.current === next.shot && !!selectedPlan.value, last, running, error };
});
// Previs blocks people as cylinders; the AI may add mannequins only after the user ticks this for the node.
const allowMannequins = computed({ get: () => data.value.allowMannequins === true, set: (value: boolean) => { data.value.allowMannequins = value; } });
// ACT: Scene and animation are held only inside the node; canvas data stores just file references,
// avoiding traversing many keyframes while dragging.
const modelDocument = shallowRef<ModelDocument>({ version: 1, scene: createEmptyScene(), plans: [] });
const plans = computed(() => modelDocument.value.plans);
const selectedPlan = computed(() => plans.value.find(plan => plan.id === data.value.selectedPlanId));
const scene = computed(() => modelDocument.value.scene);
const lighting = computed({ get: () => ({ ...getSceneLighting(scene.value), ...data.value.lighting }), set: (value: LightingSettings) => { data.value.lighting = value; } });
const sceneSettings = computed({ get: () => ({ gridVisible: true, skyVisible: true, ...data.value.sceneSettings }), set: (value: SceneSettings) => { data.value.sceneSettings = value; } });
const editing = ref(false);
const tasks = ref<DirectorGeneration[]>([]);
const modelsLoading = ref(false);
const models = ref<NodeAiModel[]>([]);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const preview = ref("");
let previewVersion = 0;
const modelLoading = ref(true);
const modelError = ref("");
const addingMannequin = ref(false);
let modelSaving = Promise.resolve();
let disposed = false;
onBeforeUnmount(() => { disposed = true; exportController.abort(new Error("导演节点已关闭，导出已停止")); });

function getModelPath() {
  if (!node.id || /[\\/]/.test(node.id) || node.id === "." || node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
  return `assets/${node.id}/model.json`;
}

async function writeModel(workspaceFiles: ReturnType<typeof files.getWorkspaceFiles>, value: ModelDocument) {
  const path = getModelPath();
  for (const directory of ["assets", `assets/${node.id}`]) {
    await workspaceFiles.mkdir(directory).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "EEXIST") throw error;
    });
  }
  await workspaceFiles.writeJson(path, value);
  return path;
}

async function loadModel() {
  modelLoading.value = true;
  modelError.value = "";
  try {
    const { modelPath, modelSnapshot } = data.value;
    if (!modelPath && !modelSnapshot) return;
    const workspaceFiles = files.getWorkspaceFiles();
    if (modelPath && modelPath !== getModelPath()) throw new Error("导演台模型文件路径无效");
    const value = modelDocumentSchema.parse(modelSnapshot ?? await workspaceFiles.readJson(modelPath!));
    if (disposed) return;
    // On copy or cross-canvas paste, pass the snapshot only once;
    // remove it only after writing to the new node directory succeeds.
    if (modelSnapshot) {
      const path = await writeModel(workspaceFiles, value);
      if (disposed) return;
      data.value.modelPath = path;
      delete data.value.modelSnapshot;
    }
    modelDocument.value = value;
    if (!selectedPlan.value) data.value.selectedPlanId = value.plans[0]?.id;
  } catch (error) {
    modelError.value = error instanceof Error ? error.message : "模型文件读取失败";
    if (!disposed) ElMessage.error(`导演台加载失败：${modelError.value}`);
  } finally {
    modelLoading.value = false;
  }
}

let modelReady = loadModel();
async function openEditor() {
  if (modelError.value) modelReady = loadModel();
  await modelReady;
  if (!disposed && !modelError.value) editing.value = true;
}

async function addMannequin() {
  if (modelLoading.value || modelError.value || addingMannequin.value || exportingVideo.value || exportingImage.value || tasks.value.some(task => !task.error)) return;
  addingMannequin.value = true;
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    const saving = modelSaving.then(async () => {
      if (disposed) return;
      const current = scene.value;
      const object = createMannequinObject(crypto.randomUUID());
      const mannequins = current.objectList.filter(item => item.objType === "mannequin");
      object.position.x = mannequins.length ? Math.max(...mannequins.map(item => item.position.x)) + 1 : 0;
      const nextScene: SceneDocument = { ...current, objectList: [...current.objectList, object] };
      if (!current.objectList.length) {
        nextScene.sceneConfig = {
          ...current.sceneConfig,
          camera: { ...current.sceneConfig.camera, position: { x: 3, y: 2.2, z: 4 } },
          controls: { target: { x: 0, y: 0.9, z: 0 } },
        };
      }
      const value: ModelDocument = { ...modelDocument.value, scene: sceneSchema.parse(nextScene) };
      const path = await writeModel(workspaceFiles, value);
      if (disposed) return;
      modelDocument.value = value;
      data.value.modelPath = path;
    });
    modelSaving = saving.catch(() => {});
    await saving;
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : "人偶添加失败");
  } finally {
    addingMannequin.value = false;
  }
}

async function addTurnaround(aspect: number) {
  if (modelLoading.value || modelError.value || addingMannequin.value || exportingVideo.value || exportingImage.value || tasks.value.some(task => !task.error)) return;
  addingMannequin.value = true;
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    const saving = modelSaving.then(async () => {
      if (disposed) return;
      const { scene: nextScene, view } = createTurnaround(scene.value, aspect);
      const value: ModelDocument = { ...modelDocument.value, scene: sceneSchema.parse(nextScene) };
      const path = await writeModel(workspaceFiles, value);
      if (disposed) return;
      modelDocument.value = value;
      data.value.modelPath = path;
      anchors.value = [...anchors.value, anchorSchema.parse(view)];
    });
    modelSaving = saving.catch(() => {});
    await saving;
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : translate("Failed to add the turnaround"));
  } finally {
    addingMannequin.value = false;
  }
}

nodeEvent.on("copy", async () => {
  await nodeEvent.emit("save");
  if (modelError.value) throw new Error(`导演台模型未加载，无法复制：${modelError.value}`);
  return { modelPath: undefined, modelSnapshot: modelDocument.value };
});

nodeEvent.on("save", async (reason) => {
  await modelReady;
  let pending: Promise<void>;
  do {
    pending = modelSaving;
    await pending;
  } while (pending !== modelSaving);
  if (reason === "reload" && (exportingVideo.value || exportingImage.value || tasks.value.some(task => !task.error))) {
    throw new Error("导演台正在生成或导出，请完成后再刷新节点");
  }
});

// Colour renders are marked as previs on the canvas: a video for timing and review only, an image as a keyframe's
// layout once its shot is set. Depth renders stay plain control maps.
async function exportToCanvas(kind: "image" | "video", key: string, aspect: number, render: (signal: AbortSignal) => Promise<File>, extra?: { role: NodeRole; shot?: number; blocking?: string }) {
  if (kind === "video" ? exportingVideo.value : exportingImage.value) return;
  const type = `remote-${kind}Node`;
  if (!nodeTypes?.value?.[type]) return void ElMessage.error(`请先启用${kind === "image" ? "图片" : "视频"}节点插件`);
  if (kind === "video") { exportingVideo.value = true; exportProgress.value = 0; }
  else exportingImage.value = key;
  const id = crypto.randomUUID();
  let exportNode: ReturnType<typeof findNode<NodeData & { exportProgress?: number }>>;
  let discarded = false;
  let committed = false;
  let uploadStarted = false;
  let stopWatching = () => {};
  let workspaceFiles: ReturnType<typeof files.getWorkspaceFiles> | undefined;
  function addExportNode(label: string) {
    const width = 240 * aspect + 18;
    const x = node.computedPosition.x + (node.dimensions.width || 320) + 80;
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
      const position = other.computedPosition;
      if (position.x < x + width && position.x + (other.dimensions.width || 320) > x && position.y < y + 320 && position.y + (other.dimensions.height || 300) > y) {
        y = position.y + (other.dimensions.height || 300) + 24;
      }
    }
    addNodes({ id, type, position: { x, y }, data: { label, outputs: {}, ...extra } });
    return findNode(id)!;
  }
  try {
    workspaceFiles = files.getWorkspaceFiles();
    if (kind === "video") {
      exportNode = addExportNode(extra?.shot ? t`Shot ${extra.shot} previs` : selectedPlan.value?.name ?? "视频");
      // ACT: Export progress only lives in the current run; never write it to the canvas or copy it to another node.
      Object.defineProperty(exportNode.data, "exportProgress", { value: 0, writable: true, configurable: true });
      stopWatching = watch([() => findNode(id), exportProgress], ([current, progress]) => {
        if (current !== exportNode) discarded = true;
        if (!discarded) exportNode!.data.exportProgress = progress;
      }, { flush: "sync" });
    }
    const file = await render(exportController.signal);
    exportController.signal.throwIfAborted();
    if (discarded) return;
    uploadStarted = true;
    const path = await mediaFiles.uploadFile(id, file);
    exportController.signal.throwIfAborted();
    if (discarded) return;
    if (findNode(node.id) !== node || !nodeTypes?.value?.[type]) throw new Error("画布节点已变化，请重新导出");
    exportNode ??= addExportNode(file.name.replace(/\.[^.]+$/, ""));
    // Update the existing output object so mounted video nodes and nodes connected to them receive the result.
    (exportNode.data.outputs ??= {})[kind] = {
      dataType: kind === "image" ? "IMAGE" : "VIDEO", value: { url: path, mimeType: file.type },
    };
    committed = true;
    if (kind === "video") exportProgress.value = 100;
    ElMessage.success(`${kind === "image" ? "图片" : "视频"}已导出到画布`);
  } catch (error) {
    if (!disposed && !discarded) ElMessage.error(error instanceof Error ? error.message : "导出失败，请重试");
    if (exportNode && findNode(id) === exportNode) removeNodes(id);
  } finally {
    stopWatching();
    if (exportNode) delete exportNode.data.exportProgress;
    if (uploadStarted && !committed) {
      try { await workspaceFiles!.remove(`assets/${id}`, true); }
      catch (cleanupError) {
        const code = (cleanupError as { response?: { data?: { data?: { code?: string } } } })?.response?.data?.data?.code;
        if (!disposed && code !== "ENOENT") ElMessage.error("导出中断，临时素材清理失败");
      }
    }
    if (kind === "video") exportingVideo.value = false;
    else exportingImage.value = "";
  }
  return committed;
}

async function exportVideo(aspect: number, pass: RenderPass) {
  const plan = selectedPlan.value;
  if (!plan || exportingVideo.value) return;
  exportingVideo.value = true;
  exportProgress.value = 0;
  let issues: PlanIssue[];
  try {
    issues = await reviewPlan(scene.value, plan, aspect, exportController.signal);
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : "粗模试演检查失败");
    return;
  } finally {
    exportingVideo.value = false;
  }
  if (issues.length) {
    const shown = issues.slice(0, 20).map(issue => h("li", `${issue.time.toFixed(2)} 秒：${issue.message}`));
    if (issues.length > shown.length) shown.push(h("li", `另有 ${issues.length - shown.length} 项`));
    const proceed = await ElMessageBox.confirm(h("ul", shown), "粗模试演检查发现问题", {
      confirmButtonText: "仍然导出", cancelButtonText: "返回修改", type: "warning", closeOnClickModal: false,
    }).then(() => true, () => false);
    if (!proceed || disposed || selectedPlan.value !== plan) return;
  }
  return exportToCanvas("video", "video", aspect, signal => renderVideo(scene.value, plan, aspect, signal, value => { exportProgress.value = value; }, lighting.value, sceneSettings.value, pass), pass === "color" ? { role: "previs" } : undefined);
}

function exportImage(anchor: CameraAnchor, aspect: number, time: number, pass: RenderPass) {
  const name = `关键帧${anchors.value.findIndex(item => item.id === anchor.id) + 1}${pass === "depth" ? " (depth)" : ""}`;
  return exportToCanvas("image", anchor.id, aspect, async signal => {
    const file = await renderImage(scene.value, anchor, aspect, time, signal, selectedPlan.value, lighting.value, sceneSettings.value, pass);
    return new File([file], `${name}.png`, { type: file.type });
  }, pass === "color" ? { role: "layout" } : undefined);
}

async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  try {
    const available = await ai.getModels();
    if (disposed) return;
    models.value = available;
    const first = models.value[0];
    // ACT: Pick the default model only for empty config; keep a temporarily unavailable previous selection.
    if (!model.value) model.value = first ? JSON.stringify([first.providerId, first.modelId]) : "";
  } catch (error) {
    if (!disposed) ElMessage.error(error instanceof Error ? error.message : "模型加载失败");
  } finally {
    modelsLoading.value = false;
  }
}

async function renderPreview(scene: SceneDocument, plan: DirectorPlan | undefined, lighting: LightingSettings, settings: SceneSettings) {
  const runtime = await createStage(document.createElement("canvas"), scene, undefined, undefined, lighting, settings);
  let player: ReturnType<typeof prepareSceneAnimation> | undefined;
  try {
    if (plan) {
      player = prepareSceneAnimation(runtime, plan);
      player.setTime(plan.duration);
      sampleMotion(runtime.camera, prepareMotion(plan.cameraFrames), plan.duration);
    }
    return capturePreview(runtime);
  } finally {
    player?.dispose();
    disposeStage(runtime);
  }
}

const planPreviews = new WeakMap<DirectorPlan, { scene: SceneDocument; lighting: LightingSettings; settings: SceneSettings; image: string }>();
watch([scene, selectedPlan, lighting, sceneSettings, modelLoading, previewReady], async ([value, plan, light, settings, loading, ready]) => {
  const version = ++previewVersion;
  preview.value = "";
  if (!ready || loading || modelError.value) return;
  try {
    const cached = plan && planPreviews.get(plan);
    const image = cached?.scene === value && JSON.stringify(cached.lighting) === JSON.stringify(light) && JSON.stringify(cached.settings) === JSON.stringify(settings) ? cached.image : await renderPreview(value, plan, light, settings);
    if (plan) planPreviews.set(plan, { scene: value, lighting: light, settings, image });
    if (!disposed && version === previewVersion) preview.value = image;
  } catch (error) {
    if (!disposed && version === previewVersion) ElMessage.error(error instanceof Error ? error.message : "预览生成失败");
  }
}, { immediate: true });

function setPrompt(value: string) {
  prompt.value = value;
  promptModel.value = value ? value.split("\n").map(text => [{ type: "Write", text }]) : [];
}

/**
 * Advances the shot list's previs: blocks the next shot, or, once its plan is generated and checked, exports the
 * selected plan's opening frame as that shot's layout image and blocks the shot after it.
 */
async function stepPrevis(aspect: number) {
  const queue = data.value.previs;
  const step = previsStep.value;
  if (!queue || !step) return;
  if (step.confirm) {
    const plan = selectedPlan.value!;
    const anchor = anchorSchema.parse({ ...plan.cameraFrames[0]!.view, time: 0 });
    // Measured once here, so keyframe prompts and text-only models get the same blocking the layout image shows.
    const blocking = await describeBlocking(scene.value, plan, aspect);
    const exported = await exportToCanvas("image", `previs-${step.shot}`, aspect, async signal => {
      const file = await renderImage(scene.value, anchor, aspect, 0, signal, plan, lighting.value, sceneSettings.value, "color");
      return new File([file], `${t`Shot ${step.shot} previs layout`}.png`, { type: file.type });
    }, { role: "layout", shot: step.shot, blocking });
    if (!exported || disposed) return;
    // The shot's colour render goes to its video node as a blocking reference: where people stand and move, and the camera.
    const rendered = await exportToCanvas("video", "video", aspect, signal => renderVideo(scene.value, plan, aspect, signal, value => { exportProgress.value = value; }, lighting.value, sceneSettings.value, "color"), { role: "previs", shot: step.shot });
    if (!rendered || disposed) return;
    queue.done = [...queue.done, step.shot];
    delete queue.current;
  }
  const next = queue.shots.find(item => !queue.done.includes(item.shot));
  if (!next) return void ElMessage.success(translate("Every shot of the previs is confirmed; Build shot nodes connects each layout to its keyframe"));
  setPrompt(next.instruction);
  await generate(next.shot);
}

async function generate(previsShot?: number) {
  if (modelLoading.value || modelError.value || addingMannequin.value) return;
  const choice = selectedModel.value;
  const requirement = prompt.value.trim();
  if (!choice || !requirement) return;
  // Accept only one request while the base model is first created; later animations can generate in parallel.
  if (!scene.value.objectList.length && tasks.value.some(task => !task.error)) return;
  const baseScene = scene.value;
  const basePlanId = data.value.selectedPlanId ?? "";
  const task = { id: crypto.randomUUID(), instruction: requirement };
  tasks.value = [...tasks.value, task];
  setPrompt("");
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    assertReferencesReady();
    const mediaReferences = refList.value
      .filter(item => item.value !== undefined && (item.dataType === "STRING" || item.dataType === "IMAGE" || item.dataType === "VIDEO"))
      .map(item => item.dataType === "STRING" ? { dataType: item.dataType, value: item.value } : { dataType: item.dataType, value: { ...item.value } });
    const directory = mediaReferences.some(item => item.dataType !== "STRING") ? (await workspaceFiles.list()).directory : undefined;
    if (disposed) return;
    const result = await planShot({
      generate: request => ai.generate(request), providerId: choice.providerId, modelId: choice.modelId, instruction: requirement,
      scene: baseScene, basePlan: selectedPlan.value, plans: plans.value, allowMannequins: allowMannequins.value,
      anchors: anchors.value, selectedPlanId: basePlanId, references: mediaReferences, directory,
    });
    if (disposed) return;
    const nextScene = result.scene;
    const draft = { sceneChanged: result.sceneChanged };
    const plan = { ...result.plan, id: task.id, instruction: requirement };
    // Tools only edit the draft; when done, verify the actual render, and replace the current plan only once persisted.
    const previewLighting = { ...getSceneLighting(nextScene), ...data.value.lighting };
    const previewSettings = sceneSettings.value;
    const image = await renderPreview(nextScene, plan, previewLighting, previewSettings);
    if (disposed) return;
    // Animation requests can generate in parallel; writes to the same model file are sequential,
    // and the current scene is replaced only after a successful write.
    const saving = modelSaving.then(async () => {
      if (disposed) return;
      if (scene.value !== baseScene) throw new Error("基础模型已被另一条指令更新，请基于当前模型重试。");
      const objects = new Map(nextScene.objectList.map(object => [object.threeJsonId, object]));
      const previousPlans = draft.sceneChanged
        ? plans.value.map(item => ({ ...item, tracks: item.tracks.filter(track => objects.has(track.objectId) && (!track.joint || objects.get(track.objectId)?.objType === "mannequin")) }))
        : plans.value;
      const value: ModelDocument = { version: 1, scene: nextScene, plans: [...previousPlans, plan] };
      const path = await writeModel(workspaceFiles, value);
      if (disposed) return;
      planPreviews.set(plan, { scene: nextScene, lighting: previewLighting, settings: previewSettings, image });
      modelDocument.value = value;
      data.value.modelPath = path;
      if ((data.value.selectedPlanId ?? "") === basePlanId) data.value.selectedPlanId = plan.id;
      // A previs shot waits for the user's check; the new plan is selected so confirming exports this one.
      if (previsShot && data.value.previs) {
        data.value.previs.current = previsShot;
        data.value.selectedPlanId = plan.id;
      }
    });
    modelSaving = saving.catch(() => {});
    await saving;
    tasks.value = tasks.value.filter(item => item.id !== task.id);
  } catch (error) {
    if (!disposed) tasks.value = tasks.value.map(item => item.id === task.id ? { ...item, error: error instanceof Error ? error.message : translate("生成失败，请重试") } : item);
  }
}
// The AI agent drives a shot list's previs through the same step as the bar's button; a step runs in the background.
let previsStepping = false;
nodeTools.register({
  name: "stepPrevis",
  description: "For a previs node made from a shot list: block the next shot (the director model plans it in the background, people as cylinders), or, once node:getPrevisStatus says the shot is ready to confirm, export its layout image and previs video to the canvas and block the shot after it, as the bar's Block shot and Confirm shot buttons do. ratio is the film's aspect ratio. Have each blocked shot checked, by the user in the Director's Studio unless they let you go on, before confirming it.",
  parameters: z.strictObject({ ratio: z.string().regex(/^[1-9]\d?:[1-9]\d?$/).default("16:9") }),
  execute({ ratio }) {
    const step = previsStep.value;
    if (!step) throw new Error("This node has no previs shot left to block");
    if (previsStepping || step.running) throw new Error(`Shot ${step.shot} is still being blocked or exported; poll node:getPrevisStatus`);
    const [width, height] = ratio.split(":").map(Number) as [number, number];
    previsStepping = true;
    void stepPrevis(width / height).finally(() => { previsStepping = false; });
    return { shot: step.shot, action: step.confirm ? "confirm" : "block" };
  },
});

nodeTools.register({
  name: "getPrevisStatus",
  description: "This node's shot list previs: the confirmed shots, and the next shot with whether it is being blocked or exported, ready to confirm, or failed and why.",
  parameters: z.strictObject({}),
  execute() {
    const queue = data.value.previs;
    if (!queue) return { previs: false };
    const step = previsStep.value;
    return { previs: true, total: queue.shots.length, done: queue.done, next: step ? { ...step, busy: previsStepping || step.running } : null };
  },
});
</script>

<style scoped lang="scss">
.directorContent {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  cursor: pointer;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

  .scenePreview {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .emptyPreview {
    display: flex;
    height: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--el-text-color-placeholder);
  }

}
</style>
