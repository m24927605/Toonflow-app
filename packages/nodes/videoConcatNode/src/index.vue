<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="joining ? '' : previewUrl"
    :downloadName="`${nodeProps.label || 'video'}.mp4`"
    :generationStatus="generationStatus"
    :bottomWidth="460"
    @fullscreen="player?.enterFullscreen()">
    <div class="joinContent nopan">
      <videoPlayer v-if="previewUrl && !joining" ref="player" :src="previewUrl" />
    </div>
    <template #bottom>
      <el-card class="joinCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
        <div class="joinFooter">
          <el-checkbox v-model="smoothCuts" :disabled="joining" :title="translate('Fade the sound in and out over 50 ms at every cut, to remove clicks; clip lengths stay the same')">{{ translate("Smooth cuts") }}</el-checkbox>
          <el-button v-if="joining" @click="controller?.abort()">{{ translate("Cancel") }}</el-button>
          <el-button type="primary" :loading="joining" :disabled="refList.length < 2" @click="join">{{ translate("Join") }}</el-button>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { t, translate } from "@toonflow/i18n/vue";
import { computed, onBeforeUnmount, ref } from "vue";
import { IconMovie } from "@tabler/icons-vue";
import { ElButton, ElCard, ElCheckbox, ElMessage } from "element-plus";
import { nodeSkeleton, useNode, useNodeFfmpeg, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import referenceItem from "@toonflow/node-shared/referenceItem";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import { concatVideos } from "./concatVideos";

defineOptions({
  inheritAttrs: false,
  icon: IconMovie,
  handles: [
    { id: "in", type: "target", dataType: ["VIDEO"], label: "Videos to join" },
    { id: "video", type: "source", dataType: "VIDEO", label: "Joined video" },
  ] satisfies NodeHandle[],
});
const { node, nodeProps, outputs, nodeEvent, files } = useNode({ label: "Join videos" });
const { refList, setReferencePreview, removeReference, assertReferencesReady } = useNodeReferences();
const loadFfmpeg = useNodeFfmpeg();
const player = ref<InstanceType<typeof videoPlayer>>();
const joining = ref(false);
const failed = ref(false);
const controller = ref<AbortController>();
const data = computed(() => node.data as typeof node.data & { smoothCuts?: boolean });
const smoothCuts = computed({ get: () => data.value.smoothCuts !== false, set: (value: boolean) => { data.value.smoothCuts = value; } });
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => ElMessage.error(error instanceof Error ? error.message : translate("Failed to read the video")));
const generationStatus = computed(() => joining.value ? "running" : failed.value ? "failed" : outputFile.value ? "succeeded" : "idle");

nodeEvent.on("save", reason => {
  if (reason === "reload" && joining.value) throw new Error(translate("Videos are being joined; wait or cancel before reloading the node"));
});
nodeEvent.on("delete", async () => {
  controller.value?.abort();
  await files.removeNodeFiles();
});
onBeforeUnmount(() => controller.value?.abort());

/** Joins the connected videos in the order of the list below the node into a new file owned by this node. */
async function join() {
  if (joining.value) return;
  const current = controller.value = new AbortController();
  joining.value = true;
  failed.value = false;
  const workspace = files.getWorkspaceFiles();
  const path = `assets/${node.id}/${crypto.randomUUID()}.mp4`;
  let written = false;
  try {
    assertReferencesReady();
    const sources = refList.value.flatMap(item => item.dataType === "VIDEO" && item.value ? [item.value.url as string] : []);
    for (const directory of ["assets", `assets/${node.id}`]) {
      await workspace.mkdir(directory).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
    }
    const ffmpeg = await loadFfmpeg(current.signal);
    written = true;
    const { duration } = await concatVideos(ffmpeg, sources, path, smoothCuts.value, current.signal);
    // Earlier joined files stay on disk, like other nodes' history; only the output switches to the new file.
    outputs.value.video = { dataType: "VIDEO", value: { url: path, mimeType: "video/mp4" } };
    ElMessage.success(t`Joined ${sources.length} videos, ${duration.toFixed(1)} s`);
  } catch (error) {
    if (written) await workspace.remove(path).catch(() => {});
    if (current.signal.aborted) return;
    failed.value = true;
    ElMessage.error((error as { response?: { data?: { message?: string } } })?.response?.data?.message || (error instanceof Error ? error.message : translate("Failed to join the videos")));
  } finally {
    joining.value = false;
    controller.value = undefined;
  }
}
</script>

<style scoped lang="scss">
.joinContent {
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);
}

.joinCard {
  .joinFooter {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
}
</style>
