<template>
  <div class="machineStatus">
    <el-popover trigger="click" placement="bottom-end" :width="300" :showArrow="false" :popperStyle="{ padding: '16px', maxWidth: 'calc(100vw - 24px)' }">
      <template #reference>
        <el-button class="statusButton" text :aria-label="summary" :title="summary">
          <span class="statusDot" :class="tone" aria-hidden="true" />
          <icon-server :size="16" aria-hidden="true" />
          <span class="statusLabel">{{ compact ? onlineCount : summary }}</span>
        </el-button>
      </template>
      <section class="machineDetails" aria-label="Toonflow 機器狀態">
        <strong>Toonflow 機器狀態</strong>
        <ul v-if="snapshot">
          <li v-for="machine in snapshot.machines" :key="machine.lane">
            <span>{{ translate(roles[machine.lane] ?? '其他工作') }} · {{ machine.gpu }}</span>
            <span class="machineState">{{ translate(labels[fresh ? machine.state : 'unknown']) }}</span>
          </li>
        </ul>
        <p v-else>{{ summary }}</p>
        <p v-if="snapshot" class="updatedAt">{{ updatedAt }}</p>
      </section>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref } from "vue";
import { storeToRefs } from "pinia";
import { ElButton, ElPopover } from "element-plus";
import { IconServer } from "@tabler/icons-vue";
import { locale, t, translate } from "@toonflow/i18n/vue";
import { useMachineStatusStore, type MachineState } from "@/stores/machineStatus";

defineProps<{ compact?: boolean }>();
const { snapshot, available, receivedAt } = storeToRefs(useMachineStatusStore());
const now = ref(performance.now());
const clock = setInterval(() => { now.value = performance.now(); }, 1000);
onScopeDispose(() => clearInterval(clock));
const fresh = computed(() => available.value && now.value - receivedAt.value < 45_000);
const roles = ["文字模型", "圖片與影片", "配音", "其他工作"];
const labels: Record<MachineState, string> = {
  disconnected: "未連線", off: "已關機", starting: "啟動中", working: "已開機 · 處理中", idle: "已開機 · 閒置", stopping: "關機中", unknown: "尚無法確認",
};
const onlineCount = computed(() => fresh.value ? snapshot.value?.machines.filter(row => row.state === "working" || row.state === "idle").length ?? 0 : "?");
const summary = computed(() => {
  if (!snapshot.value && now.value - receivedAt.value < 15_000) return translate("正在讀取機器狀態…");
  if (!fresh.value || snapshot.value?.machines.some(row => row.state === "unknown")) return translate("機器狀態待確認");
  if (snapshot.value?.machines.some(row => row.state === "stopping")) return translate("機器關閉中");
  if (snapshot.value?.machines.some(row => row.state === "starting")) return translate("機器啟動中");
  if (onlineCount.value) return t`${onlineCount.value} 台機器已啟動`;
  return translate(snapshot.value?.machines.every(row => row.state === "off") ? "機器已關閉" : "機器未連線");
});
const tone = computed(() => !fresh.value || snapshot.value?.machines.some(row => row.state === "unknown") ? "unknown" : onlineCount.value ? "online" : "offline");
const updatedAt = computed(() => snapshot.value ? t`更新於 ${new Intl.DateTimeFormat(locale.value, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(snapshot.value.checkedAt))}` : "");
</script>

<style scoped lang="scss">
.machineStatus {
  min-width: 0;
  .statusButton { min-height: 40px; max-width: 100%; gap: 6px; padding: 8px 10px; font-size: 12px; color: var(--el-text-color-secondary); }
  .statusLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .statusDot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--el-text-color-placeholder); &.online { background: var(--el-color-success); } &.unknown { background: var(--el-color-warning); } }
}
.machineDetails {
  font-size: 12px;
  ul { list-style: none; padding: 0; margin: 12px 0; }
  li { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; }
  .machineState { color: var(--el-text-color-secondary); }
  p { margin: 10px 0 0; line-height: 1.6; color: var(--el-text-color-secondary); }
  .updatedAt { font-variant-numeric: tabular-nums; }
  .updatedAt { color: var(--el-text-color-placeholder); }
}
</style>
