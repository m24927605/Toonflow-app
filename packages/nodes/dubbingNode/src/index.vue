<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="420"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }">
    <div v-loading="processing" class="dubbingContent nopan" :aria-busy="processing">
      <videoPlayer v-if="previewUrl" ref="player" :src="previewUrl" label="配音合成视频" @loadedmetadata="resizeVideo" />
      <div v-else class="dubbingEmpty" role="img" aria-label="暂无合成视频">
        <icon-microphone :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template #bottom>
      <el-card class="settingsCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <div class="settingsBody nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
          <div class="settingRow">
            <span class="settingLabel">配音开始</span>
            <el-input-number v-model="data.start" :min="0" :step="0.1" :precision="2" :valueOnClear="0" :disabled="processing" controlsPosition="right" size="small" aria-label="配音开始时间" />
            <span class="settingUnit">秒</span>
          </div>
          <div class="settingRow">
            <span class="settingLabel">配音音量</span>
            <el-slider v-model="data.voiceVolume" class="volumeSlider" :min="0" :max="200" :disabled="processing" aria-label="配音音量" />
            <span class="settingUnit">{{ data.voiceVolume }}%</span>
          </div>
          <div class="settingRow">
            <span class="settingLabel">配音时原声</span>
            <el-slider v-model="data.originalVolume" class="volumeSlider" :min="0" :max="200" :disabled="processing" aria-label="配音时原声音量" />
            <span class="settingUnit">{{ data.originalVolume }}%</span>
          </div>
          <div class="settingsFooter">
            <el-button type="primary" :icon="processing ? IconPlayerStop : IconWand" @click="processing ? controller?.abort() : startCompose()">{{ processing ? "停止" : "合成" }}</el-button>
          </div>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { ElButton, ElCard, ElInputNumber, ElLoading, ElSlider, ElMessage } from "element-plus";
import { IconMicrophone, IconPlayerStop, IconWand } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, useNodeInputs, z, type NodeHandle, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import { dubVideo } from "./dubbing";

defineOptions({
  inheritAttrs: false,
  icon: IconMicrophone,
  handles: [
    { id: "video", type: "target", dataType: "VIDEO", label: "视频输入" },
    { id: "audio", type: "target", dataType: "AUDIO", label: "配音输入" },
    { id: "output", type: "source", dataType: "VIDEO", label: "视频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ffmpeg: loadFfmpeg, updateNodeInternals } = useNode({
  label: "配音合成",
});
const { getTargetValues } = useNodeInputs();
const data = computed(() => node.data as { start: number; voiceVolume: number; originalVolume: number });
data.value.start ??= 0;
data.value.voiceVolume ??= 100;
// The original audio is silenced only while the dubbing plays; ambience before and after it stays.
data.value.originalVolume ??= 0;
const settingsSchema = z.strictObject({
  start: z.number().min(0).optional(),
  voiceVolume: z.number().int().min(0).max(200).optional(),
  originalVolume: z.number().int().min(0).max(200).optional(),
});
const player = ref<InstanceType<typeof videoPlayer>>();
const videoWidth = ref(0);
const processing = ref(false);
const controller = ref<AbortController>();
let job: Promise<unknown> | undefined;

const outputFile = computed(() => outputs.value.output?.dataType === "VIDEO" ? outputs.value.output.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => showNodeError(error, "视频读取失败"));

// ACT: Each input takes a single edge, so the node never has to guess which video or dubbing to use.
nodeEvent.on("canConnect", (connection, { edges }) =>
  !edges.some(edge => edge.target === connection.target && edge.targetHandle === connection.targetHandle));
nodeEvent.on("save", reason => {
  if (reason === "reload" && processing.value) throw new Error("配音合成中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  controller.value?.abort();
  await job;
  await files.removeNodeFiles();
});

function readInput(handleId: "video" | "audio") {
  const input = getTargetValues(id, handleId)[0];
  return input?.dataType === handleId.toUpperCase() ? input.value as NodeMediaValue | undefined : undefined;
}

function getConfig() {
  return { ...data.value, videoConnected: !!readInput("video"), audioConnected: !!readInput("audio") };
}

function compose(signal?: AbortSignal) {
  if (processing.value) throw new Error("配音正在合成，请等待完成");
  const video = readInput("video");
  const audio = readInput("audio");
  if (!video) throw new Error("请先连接有内容的视频");
  if (!audio) throw new Error("请先连接有内容的配音");
  const current = controller.value = new AbortController();
  signal?.addEventListener("abort", () => current.abort(signal.reason), { once: true });
  const workspace = files.getWorkspaceFiles();
  const outputPath = `assets/${id}/${crypto.randomUUID()}.mp4`;
  processing.value = true;
  const task = (async () => {
    try {
      const ffmpeg = await loadFfmpeg(current.signal);
      for (const directory of ["assets", `assets/${id}`]) {
        await workspace.mkdir(directory).catch(error => { if (error?.response?.data?.data?.code !== "EEXIST") throw error; });
      }
      await dubVideo(ffmpeg, {
        videoPath: video.url,
        audioPath: audio.url,
        outputPath,
        start: data.value.start,
        voiceVolume: data.value.voiceVolume / 100,
        originalVolume: data.value.originalVolume / 100,
      }, current.signal);
      // ACT: Earlier results stay on disk so undo history and copied nodes keep their files.
      outputs.value.output = { dataType: "VIDEO", value: { url: outputPath, mimeType: "video/mp4" } };
      return outputs.value.output.value;
    } catch (error) {
      await workspace.remove(outputPath).catch(cleanupError => {
        if (cleanupError?.response?.data?.data?.code !== "ENOENT") ElMessage.error("未完成的合成文件清理失败");
      });
      throw error;
    } finally {
      processing.value = false;
      controller.value = undefined;
    }
  })();
  job = task.catch(() => undefined);
  return task;
}

function startCompose() {
  try {
    compose().catch(error => {
      if (!(error instanceof DOMException && error.name === "AbortError")) showNodeError(error, "配音合成失败");
    });
  } catch (error) {
    showNodeError(error, "配音合成失败");
  }
}

async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, (240 * video.videoWidth) / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}

nodeTools.register({
  name: "setConfig",
  description: "修改配音合成参数并返回当前参数与输入连接状态：start 为配音开始秒数，voiceVolume 为配音音量，originalVolume 为配音播放期间原声的音量，均为 0–200 的百分比；配音前后原声保持 100%，originalVolume 为 0 时配音期间只听到配音；不传参数即只读取，不启动合成",
  parameters: settingsSchema,
  execute(args) {
    if (processing.value) throw new Error("配音正在合成，请稍后修改");
    Object.assign(data.value, Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined)));
    return getConfig();
  },
});

nodeTools.register({
  name: "compose",
  description: "按当前参数把配音输入混入视频输入，生成新的视频输出并返回其路径；画面不重新编码，时长与原视频相同，原文件保留",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    return compose(signal);
  },
});
</script>

<style scoped lang="scss">
.dubbingContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .dubbingEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }
}

.settingsCard {
  .settingsBody {
    display: grid;
    grid-template-columns: max-content 1fr 48px;
    gap: 10px 12px;

    .settingRow {
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns: subgrid;
      align-items: center;
      font-size: 13px;

      .settingLabel {
        color: var(--el-text-color-regular);
        white-space: nowrap;
      }

      // The slider handle overhangs the track at 0%, so keep it clear of the label.
      .volumeSlider {
        padding-left: 10px;
      }

      .settingUnit {
        color: var(--el-text-color-secondary);
        font-variant-numeric: tabular-nums;
      }
    }

    .settingsFooter {
      display: flex;
      grid-column: 1 / -1;
      justify-content: flex-end;
    }
  }
}
</style>
