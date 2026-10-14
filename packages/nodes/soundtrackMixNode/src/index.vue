<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="mixing ? '' : previewUrl"
    :downloadName="`${nodeProps.label || 'video'}.mp4`"
    :generationStatus="generationStatus"
    :bottomWidth="460"
    @fullscreen="player?.enterFullscreen()">
    <div class="mixContent nopan">
      <videoPlayer v-if="previewUrl && !mixing" ref="player" :src="previewUrl" />
    </div>
    <template #bottom>
      <el-card class="mixCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
        <div class="mixOption">
          <span>{{ translate("Track volume") }}</span>
          <el-slider v-model="volume" :min="0" :max="100" :disabled="mixing" :formatTooltip="(value: number) => `${value}%`" :aria-label="translate('Track volume')" />
        </div>
        <div class="mixOption">
          <span>{{ translate("Fade in and out") }}</span>
          <el-input-number v-model="fade" :min="0" :max="10" :step="0.5" :precision="1" size="small" :disabled="mixing" :aria-label="translate('Fade in and out')" />
          <span>{{ translate("s") }}</span>
        </div>
        <div class="mixFooter">
          <el-checkbox v-model="duck" :disabled="mixing">{{ translate("Lower the tracks while the video has sound, such as dialogue") }}</el-checkbox>
          <el-button v-if="mixing" @click="controller?.abort()">{{ translate("Cancel") }}</el-button>
          <el-button type="primary" :loading="mixing" :disabled="!videoInput || !trackInputs.length" @click="mix">{{ translate("Mix") }}</el-button>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { t, translate } from "@toonflow/i18n/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { IconMusic } from "@tabler/icons-vue";
import { ElButton, ElCard, ElCheckbox, ElInputNumber, ElMessage, ElSlider } from "element-plus";
import { nodeSkeleton, useNode, useNodeFfmpeg, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import referenceItem from "@toonflow/node-shared/referenceItem";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import { mixSoundtrack } from "./mixSoundtrack";

defineOptions({
  inheritAttrs: false,
  icon: IconMusic,
  handles: [
    { id: "in", type: "target", dataType: ["VIDEO", "AUDIO"], label: "Video and soundtrack" },
    { id: "video", type: "source", dataType: "VIDEO", label: "Video with soundtrack" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, nodeEvent, files } = useNode({ label: "Add soundtrack" });
const { refList, setReferencePreview, removeReference, assertReferencesReady } = useNodeReferences();
const loadFfmpeg = useNodeFfmpeg();
const player = ref<InstanceType<typeof videoPlayer>>();
const mixing = ref(false);
const failed = ref(false);
const controller = ref<AbortController>();
const data = computed(() => node.data as typeof node.data & { volume?: number; fade?: number; duck?: boolean });
// Background music usually sits well under dialogue at about a third of full level.
const volume = computed({ get: () => data.value.volume ?? 30, set: (value: number) => { data.value.volume = value; } });
const fade = computed({ get: () => data.value.fade ?? 1.5, set: (value: number) => { data.value.fade = value; } });
const duck = computed({ get: () => data.value.duck !== false, set: (value: boolean) => { data.value.duck = value; } });
const videoInput = computed(() => refList.value.find(item => item.dataType === "VIDEO"));
const trackInputs = computed(() => refList.value.filter(item => item.dataType === "AUDIO"));
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => ElMessage.error(error instanceof Error ? error.message : translate("Failed to read the video")));
const generationStatus = computed(() => mixing.value ? "running" : failed.value ? "failed" : outputFile.value ? "succeeded" : "idle");

nodeEvent.on("save", reason => {
  if (reason === "reload" && mixing.value) throw new Error(translate("The soundtrack is being mixed; wait or cancel before reloading the node"));
});
nodeEvent.on("delete", async () => {
  controller.value?.abort();
  await files.removeNodeFiles();
});
onBeforeUnmount(() => controller.value?.abort());

/** Mixes the connected audio tracks under the connected video into a new file owned by this node. */
async function mix() {
  if (mixing.value) return;
  const current = controller.value = new AbortController();
  mixing.value = true;
  failed.value = false;
  const workspace = files.getWorkspaceFiles();
  const path = `assets/${node.id}/${crypto.randomUUID()}.mp4`;
  let started = false;
  try {
    assertReferencesReady();
    const videos = refList.value.flatMap(item => item.dataType === "VIDEO" && item.value ? [item.value.url as string] : []);
    if (videos.length !== 1) throw new Error(translate("Connect exactly one video"));
    const tracks = refList.value.flatMap(item => item.dataType === "AUDIO" && item.value ? [item.value.url as string] : []);
    for (const directory of ["assets", `assets/${node.id}`]) {
      await workspace.mkdir(directory).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
    }
    const ffmpeg = await loadFfmpeg(current.signal);
    started = true;
    const { duration } = await mixSoundtrack(ffmpeg, videos[0]!, tracks, path, { volume: volume.value / 100, fade: fade.value, duck: duck.value }, current.signal);
    // Earlier mixes stay on disk, like other nodes' history; only the output switches to the new file.
    outputs.value.video = { dataType: "VIDEO", value: { url: path, mimeType: "video/mp4" } };
    ElMessage.success(t`Mixed ${tracks.length} tracks, ${duration.toFixed(1)} s`);
  } catch (error) {
    if (started) await workspace.remove(path).catch(() => {});
    if (current.signal.aborted) return;
    failed.value = true;
    ElMessage.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message || (error instanceof Error ? error.message : translate("Failed to mix the soundtrack")));
  } finally {
    mixing.value = false;
    controller.value = undefined;
  }
}
</script>

<style scoped lang="scss">
.mixContent {
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);
}

.mixCard {
  .mixOption {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
    font-size: 12px;
    color: var(--el-text-color-regular);

    .el-slider {
      flex: 1;
    }
  }

  .mixFooter {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
}
</style>
