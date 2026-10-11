<template>
  <el-popover trigger="click" placement="bottom-end" :width="320" :disabled="!outputUrl">
    <template #reference>
      <el-button class="gradeButton" :class="current ? `level${current.level}` : 'ungraded'" text size="small" :disabled="!outputUrl" title="Quality grade of this output" aria-label="Quality grade" @click.stop>
        {{ current ? `L${current.level}` : "L?" }}
      </el-button>
    </template>
    <div class="gradePanel nodrag nopan nowheel">
      <div class="gradeChecks">
        <el-checkbox v-for="item in checks" :key="item.key" :modelValue="!!draft[item.key]" @update:modelValue="toggle(item.key, !!$event)">{{ item.label }}</el-checkbox>
      </div>
      <div class="gradeLevels">
        <el-button
          v-for="item in gradeLevels"
          :key="item.level"
          size="small"
          :type="current?.level === item.level ? 'primary' : 'default'"
          :disabled="item.level >= 3 && !allChecked"
          :title="item.hint"
          @click="setLevel(item.level)">
          {{ item.label }}
        </el-button>
      </div>
      <p v-if="!allChecked" class="gradeNote">Tick every check to allow L3 or L4.</p>
      <p v-if="lowKeeperRate(grades)" class="gradeWarning">Under 30% of this node's graded outputs reached L3: fix the prompt and references before generating more.</p>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElCheckbox, ElPopover } from "element-plus";
import { useNode } from "@vue-flow/core";
import { gradeChecks, gradeLevels, lowKeeperRate, type GradeLevel, type NodeGrades } from "../grading";

const props = defineProps<{ outputUrl?: string; kind: "image" | "video" }>();
const { node } = useNode<{ grades?: NodeGrades }>();
const grades = computed(() => node.data.grades);
const current = computed(() => props.outputUrl ? grades.value?.[props.outputUrl] : undefined);
const checks = computed(() => gradeChecks(props.kind));
const draft = ref<Record<string, boolean>>({});
const allChecked = computed(() => checks.value.every(item => draft.value[item.key]));

watch(current, grade => { draft.value = { ...grade?.checks }; }, { immediate: true });

function save(level: GradeLevel) {
  if (!props.outputUrl) return;
  // Any unchecked item caps the grade at L2.
  const capped = (allChecked.value ? level : Math.min(level, 2)) as GradeLevel;
  node.data.grades = { ...node.data.grades, [props.outputUrl]: { level: capped, checks: { ...draft.value } } };
}

function toggle(key: string, value: boolean) {
  draft.value = { ...draft.value, [key]: value };
  if (current.value) save(current.value.level);
}

function setLevel(level: GradeLevel) {
  save(level);
}
</script>

<style lang="scss" scoped>
.gradeButton {
  min-width: 32px;
  font-weight: 600;
  &.ungraded { color: var(--el-text-color-placeholder); }
  &.level1 { color: var(--el-color-danger); }
  &.level2 { color: var(--el-color-warning); }
  &.level3 { color: var(--el-color-success); }
  &.level4 { color: var(--el-color-primary); }
}
.gradePanel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  .gradeChecks { display: flex; flex-direction: column; }
  .gradeLevels { display: flex; flex-wrap: wrap; gap: 6px; .el-button { margin: 0; } }
  .gradeNote, .gradeWarning { margin: 0; font-size: 12px; line-height: 1.5; }
  .gradeNote { color: var(--el-text-color-secondary); }
  .gradeWarning { color: var(--el-color-warning); }
}
</style>
