<template>
  <el-checkbox v-if="seed !== undefined" v-model="keep" size="small" class="seedLock nodrag" :disabled="disabled"
    :title="t`Seed ${seed} of the current result: keep it to change only what you edit and compare with the history`">
    {{ translate("Keep seed") }}
  </el-checkbox>
</template>

<script setup lang="ts">
import { ElCheckbox } from "element-plus";
import { t, translate } from "@toonflow/i18n/vue";

/** The seed a generation node draws with next: the current result's, while `keep` is on. */
defineProps<{ seed?: number; disabled?: boolean }>();
const keep = defineModel<boolean>("keep", { default: false });
</script>

<style scoped lang="scss">
.seedLock {
  margin-right: 0;
  white-space: nowrap;
}
</style>
