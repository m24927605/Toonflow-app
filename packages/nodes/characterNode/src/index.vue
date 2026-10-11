<template>
  <nodeSkeleton v-bind="nodeProps" v-model:bottomVisible="node.selected" :bottomWidth="420">
    <div v-loading="submitting || training" class="characterContent nopan" :aria-busy="submitting || training">
      <icon-user-scan :size="40" stroke="1.25" aria-hidden="true" />
      <template v-if="data.character">
        <span class="characterName">{{ data.character.name }}</span>
        <span class="characterMeta">{{ soulKinds[data.character.kind] }} · {{ statusText }}</span>
        <span v-if="data.character.failReason" class="characterError">{{ data.character.failReason }}</span>
      </template>
    </div>
    <template #bottom>
      <el-card class="settingsCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <div class="settingsBody nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
          <div class="settingRow">
            <span class="settingLabel">已有角色</span>
            <el-select :modelValue="data.character?.id" size="small" filterable :loading="loading" :disabled="submitting" aria-label="已有角色" @visibleChange="$event && loadSouls()" @change="selectSoul">
              <el-option v-for="soul in soulOptions" :key="soul.id" :value="soul.id" :label="soul.name" :disabled="soul.status !== 'completed'">
                <span>{{ soul.name }}</span>
                <span class="optionMeta">{{ soulKinds[soul.kind] }}</span>
              </el-option>
            </el-select>
          </div>
          <div class="sectionTitle">训练新角色</div>
          <div class="settingRow">
            <span class="settingLabel">名称</span>
            <el-input v-model="data.name" size="small" :maxlength="64" :disabled="submitting" aria-label="角色名称" />
          </div>
          <div class="settingRow">
            <span class="settingLabel">版本</span>
            <el-select v-model="data.kind" size="small" :disabled="submitting" aria-label="角色身份版本">
              <el-option v-for="(label, kind) in soulKinds" :key="kind" :value="kind" :label="label" />
            </el-select>
          </div>
          <p class="trainingHint">已连接 {{ imageCount }} 张图片，需要 5–20 张同一真人的照片，建议 8–12 张</p>
          <details class="trainingGuide">
            <summary>照片建议</summary>
            <ul>
              <li>角度：正面 4–6 张，左右 45 度各 1–2 张，左右正侧面各 1 张，可加 1 张轻微俯仰</li>
              <li>画质：脸部清晰不模糊，光线均匀，避免严重逆光或强烈阴影</li>
              <li>表情：微笑、中性、轻微说话各占一部分</li>
              <li>避免：墨镜、帽子遮脸、大量修图或滤镜</li>
            </ul>
          </details>
          <div class="settingsFooter">
            <span class="costNote">每次训练都会消耗 Higgsfield 点数</span>
            <el-button type="primary" size="small" :icon="IconSparkles" :loading="submitting" :disabled="training" @click="startTraining">训练</el-button>
          </div>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref } from "vue";
import { ElButton, ElCard, ElInput, ElLoading, ElOption, ElSelect } from "element-plus";
import { IconSparkles, IconUserScan } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, useNode, useNodeInputs, z, type NodeHandle, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { createSoul, getSoul, listSouls, soulKinds, type Soul, type SoulKind } from "./souls";

defineOptions({
  inheritAttrs: false,
  icon: IconUserScan,
  handles: [
    { id: "images", type: "target", dataType: "IMAGE", label: "训练图片输入" },
    { id: "character", type: "source", dataType: "CHARACTER", label: "角色输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, outputs, files } = useNode({ label: "角色身份" });
const { getTargetValues } = useNodeInputs();
const data = computed(() => node.data as { name: string; kind: SoulKind; character?: Soul });
data.value.name ??= "";
data.value.kind ??= "soul_2";
const souls = ref<Soul[]>([]);
const loading = ref(false);
const submitting = ref(false);
const pollInterval = 15000;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

const training = computed(() => !!data.value.character && !["completed", "failed"].includes(data.value.character.status));
// An expression body lets the i18n transform translate each status label.
const statusText = computed(() => data.value.character?.status === "completed" ? "已完成"
  : data.value.character?.status === "failed" ? "训练失败"
    : data.value.character?.status === "queued" ? "排队中" : "训练中");
const imageCount = computed(() => readImages().length);
// Keep the selected identity visible before the account list has been loaded.
const soulOptions = computed(() => souls.value.length ? souls.value : data.value.character ? [data.value.character] : []);

function readImages() {
  return getTargetValues(id, "images").flatMap(input => input.dataType === "IMAGE" && input.value ? [(input.value as NodeMediaValue).url] : []);
}

function applySoul(soul: Soul) {
  data.value.character = soul;
  if (soul.status === "completed") outputs.value.character = { dataType: "CHARACTER", value: { id: soul.id, name: soul.name, kind: soul.kind } };
  else delete outputs.value.character;
  clearTimeout(pollTimer);
  if (training.value) pollTimer = setTimeout(() => refreshSoul(soul.id), pollInterval);
}

// ACT: A failed status read stops polling instead of retrying every interval; reopening the canvas or selecting the
// identity again resumes it. Add backoff here if transient Higgsfield errors turn out to be common.
async function refreshSoul(soulId: string) {
  const soul = await getSoul(soulId).catch(error => showNodeError(error, "角色身份状态读取失败"));
  if (soul && !disposed && data.value.character?.id === soulId) applySoul(soul);
}

async function loadSouls() {
  if (loading.value) return;
  loading.value = true;
  try {
    souls.value = await listSouls();
  } catch (error) {
    showNodeError(error, "角色身份列表读取失败");
  } finally {
    loading.value = false;
  }
}

function selectSoul(soulId: string) {
  const soul = souls.value.find(item => item.id === soulId);
  if (soul) applySoul(soul);
}

async function train() {
  if (submitting.value || training.value) throw new Error("角色身份正在训练，请等待完成");
  const name = data.value.name.trim();
  if (!name) throw new Error("请填写角色名称");
  const images = readImages();
  if (images.length < 5 || images.length > 20) throw new Error(`训练需要连接 5 到 20 张图片，当前为 ${images.length} 张`);
  submitting.value = true;
  try {
    const { directory } = await files.getWorkspaceFiles().list();
    const soul = await createSoul({ directory, name, kind: data.value.kind, images });
    if (!disposed) applySoul(soul);
    return soul;
  } finally {
    submitting.value = false;
  }
}

function startTraining() {
  train().catch(error => showNodeError(error, "角色身份训练失败"));
}

if (training.value) refreshSoul(data.value.character!.id);
onScopeDispose(() => {
  disposed = true;
  clearTimeout(pollTimer);
});

nodeTools.register({
  name: "getConfig",
  description: "Read the character identity node's current character, training name, version (soul_2 or soul_cinematic) and the number of connected training images, without making any request",
  parameters: z.strictObject({}),
  execute() {
    return { name: data.value.name, kind: data.value.kind, character: data.value.character, imageCount: imageCount.value };
  },
});

nodeTools.register({
  name: "listCharacters",
  description: "List the character identities (Soul ID) that already exist in the current Higgsfield account and their training status; only completed characters can be used for generation",
  parameters: z.strictObject({}),
  async execute() {
    souls.value = await listSouls();
    return souls.value;
  },
});

nodeTools.register({
  name: "selectCharacter",
  description: "Select an existing character identity by ID as the node output; a character still in training is output automatically when it completes",
  parameters: z.strictObject({ id: z.string().uuid() }),
  async execute({ id: soulId }) {
    const soul = await getSoul(soulId);
    applySoul(soul);
    return soul;
  },
});

nodeTools.register({
  name: "train",
  description: "Train a new character identity from the 5–20 photos of the same real person connected to the training image input; every call consumes Higgsfield credits, training takes several minutes, and the node polls automatically and outputs the character when it completes. When name and kind are omitted, the node's current settings are used",
  parameters: z.strictObject({
    name: z.string().min(1).max(64).optional(),
    kind: z.enum(["soul_2", "soul_cinematic"]).optional(),
  }),
  execute({ name, kind }) {
    if (name !== undefined) data.value.name = name;
    if (kind !== undefined) data.value.kind = kind;
    return train();
  },
});
</script>

<style scoped lang="scss">
.characterContent {
  position: relative;
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 4px;
  min-width: 200px;
  min-height: 144px;
  padding: 12px;
  color: var(--el-text-color-placeholder);
  text-align: center;

  .characterName {
    color: var(--el-text-color-primary);
    font-size: 14px;
    font-weight: 600;
  }

  .characterMeta {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .characterError {
    color: var(--el-color-danger);
    font-size: 12px;
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }
}

.settingsCard {
  .settingsBody {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 10px 12px;
    font-size: 13px;

    .settingRow {
      display: grid;
      grid-column: 1 / -1;
      grid-template-columns: subgrid;
      align-items: center;

      .settingLabel {
        color: var(--el-text-color-regular);
        white-space: nowrap;
      }
    }

    .sectionTitle,
    .trainingHint,
    .trainingGuide,
    .settingsFooter {
      grid-column: 1 / -1;
    }

    .sectionTitle {
      padding-top: 6px;
      border-top: 1px solid var(--el-border-color-lighter);
      color: var(--el-text-color-primary);
      font-weight: 600;
    }

    .trainingHint {
      margin: 0;
      color: var(--el-text-color-secondary);
    }

    .trainingGuide {
      color: var(--el-text-color-secondary);

      summary {
        color: var(--el-text-color-regular);
        cursor: pointer;
      }

      ul {
        margin: 6px 0 0;
        padding-left: 18px;
        line-height: 1.6;
      }
    }

    .settingsFooter {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;

      .costNote {
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }
    }
  }
}

.optionMeta {
  float: right;
  margin-left: 12px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
