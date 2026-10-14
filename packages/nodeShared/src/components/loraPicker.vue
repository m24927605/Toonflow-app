<template>
  <div class="loraPicker nodrag">
    <el-select :modelValue="selected" multiple size="small" collapseTags collapseTagsTooltip :multipleLimit="4" :loading="loading"
      :placeholder="translate('LoRA')" :aria-label="translate('LoRA')" class="loraMenu" @visibleChange="$event && load()" @update:modelValue="pick">
      <el-option v-for="item in options" :key="item.path" :label="`${item.name} · ${kindLabels[item.kind]}`" :value="item.path" />
    </el-select>
    <span v-for="lora in sliders" :key="lora.path" class="sliderStrength">
      {{ lora.name }}
      <el-input-number :modelValue="lora.strength" size="small" :min="-4" :max="4" :step="0.25" controlsPosition="right" :aria-label="t`Strength of ${lora.name}`"
        @update:modelValue="setStrength(lora.path, $event ?? 1)" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElInputNumber, ElOption, ElSelect } from "element-plus";
import { t, translate } from "@toonflow/i18n/vue";
import { useNodeFiles, type NodeLoraFamily, type NodeLoraKind, type NodeLoraRecord } from "@toonflow/nodes-scaffold/runtime";
import { listLoras, type AttachedLora } from "../loraRegistry";

const props = defineProps<{ family: NodeLoraFamily }>();
const loras = defineModel<AttachedLora[]>({ default: () => [] });
const files = useNodeFiles();
const records = ref<NodeLoraRecord[]>([]);
const loading = ref(false);
const kindLabels = computed<Record<NodeLoraKind, string>>(() => ({
  character: translate("Character"), scene: translate("Scene"), costume: translate("Costume"), style: translate("Style"),
  motion: translate("Motion"), voice: translate("Voice"), slider: translate("Slider"),
}));
// Attached LoRAs stay listed even when their record is gone, so they can be removed.
const options = computed(() => [...records.value.filter(item => item.family === props.family), ...loras.value.filter(item => !records.value.some(record => record.path === item.path))]);
const selected = computed(() => loras.value.map(item => item.path));
const sliders = computed(() => loras.value.filter(item => item.kind === "slider"));

async function load() {
  loading.value = true;
  try {
    records.value = await listLoras(files.getWorkspaceFiles());
  } finally {
    loading.value = false;
  }
}

function pick(paths: string[]) {
  loras.value = paths.flatMap(path => {
    const kept = loras.value.find(item => item.path === path);
    if (kept) return [kept];
    const record = records.value.find(item => item.path === path);
    return record ? [{ path, trigger: record.trigger, name: record.name, kind: record.kind, family: record.family, strength: 1 }] : [];
  });
}

function setStrength(path: string, strength: number) {
  loras.value = loras.value.map(item => item.path === path ? { ...item, strength } : item);
}

onMounted(() => { if (loras.value.length) void load(); });
</script>

<style lang="scss" scoped>
.loraPicker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;

  .loraMenu { width: 180px; }

  .sliderStrength {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--el-text-color-regular);

    .el-input-number { width: 92px; }
  }
}
</style>
