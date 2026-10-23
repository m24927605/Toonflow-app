<template>
  <section class="productionProgress" :class="{ completed: progress.finished, failed }" aria-label="影片製作進度">
    <div class="progressHeader">
      <div class="progressTitle" role="status">
        <icon-check v-if="progress.finished" :size="16" aria-hidden="true" />
        <icon-alert-circle v-else-if="failed" :size="16" aria-hidden="true" />
        <span v-else class="statusDot" :class="{ active: progress.active }" aria-hidden="true" />
        <span>{{ label }}</span>
      </div>
      <span class="elapsed" aria-live="off">已用 {{ elapsed }}</span>
    </div>
    <details v-if="progress.failure?.message" class="failureDetails">
      <summary>錯誤詳情</summary>
      <p>{{ progress.failure.message }}</p>
      <details v-if="progress.failure.technical" class="technicalDetails"><summary>原始技術紀錄</summary><p>{{ progress.failure.technical }}</p></details>
    </details>
    <template v-if="!progress.finished">
      <el-progress :percentage="percentage" :showText="false" :strokeWidth="4" :status="failed ? 'exception' : undefined" :aria-label="`已完成 ${completed}／${progress.phases.length} 個製作階段`" />
      <details class="phaseDetails">
        <summary>各階段狀態<span class="phaseCount">完成 {{ completed }}／{{ progress.phases.length }}</span></summary>
        <div class="progressDetails">
          <span>完成 {{ completed }}／{{ progress.phases.length }} · 進行中 {{ running }} · {{ failed ? '未完成' : '待完成' }} {{ pending }}</span>
          <span v-if="failedCount">失敗 {{ failedCount }}</span>
          <span v-if="progress.totalShots">鏡頭完成 {{ progress.completedShots }}／{{ progress.totalShots }}</span>
        </div>
        <ul class="phaseList" aria-label="各階段狀態">
          <li v-for="phase in progress.phases" :key="phase.id" :class="phase.status">
            <icon-check v-if="phase.status === 'done'" :size="14" aria-hidden="true" />
            <icon-alert-circle v-else-if="phase.status === 'failed'" :size="14" aria-hidden="true" />
            <span v-else class="phaseDot" aria-hidden="true" />
            <span>{{ labels[phase.id] }}</span>
            <span class="phaseStatus">{{ phase.status === 'done' ? '完成' : phase.status === 'running' ? '進行中' : phase.status === 'failed' ? '失敗' : failed ? '未完成' : '待完成' }}</span>
          </li>
        </ul>
        <p v-if="failed" class="progressHint">本次製作已停止，未完成的階段不會自動繼續執行。</p>
        <p v-else class="progressHint">各階段可同時進行；進度依實際完成的工作更新。</p>
      </details>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { t } from "@toonflow/i18n/vue";
import { ElProgress } from "element-plus";
import { IconAlertCircle, IconCheck } from "@tabler/icons-vue";

export type ProductionProgress = {
  active: boolean; finished: boolean; cleanupStatus: "unknown" | "running" | "done" | "failed";
  elapsedSeconds: number; totalShots: number; completedShots: number;
  failure?: { step?: string; message?: string; technical?: string };
  phases: { id: string; status: "pending" | "running" | "done" | "failed" }[];
};
const props = defineProps<{ progress: ProductionProgress; label: string; failed: boolean }>();
const labels: Record<string, string> = { preparation: "準備資源", story: "劇本與分鏡", visuals: "角色與場景", speech: "聲音製作", video: "鏡頭生成", finishing: "剪輯與後製", cleanup: "完成收尾" };
const completed = computed(() => props.progress.phases.filter(phase => phase.status === "done").length);
const running = computed(() => props.progress.phases.filter(phase => phase.status === "running").length);
const pending = computed(() => props.progress.phases.filter(phase => phase.status === "pending").length);
const failedCount = computed(() => props.progress.phases.filter(phase => phase.status === "failed").length);
const percentage = computed(() => props.progress.phases.length ? completed.value / props.progress.phases.length * 100 : 0);
const elapsedSeconds = ref(props.progress.elapsedSeconds);
let timer: ReturnType<typeof setInterval> | undefined;
watch(() => props.progress, value => {
  clearInterval(timer);
  elapsedSeconds.value = value.elapsedSeconds;
  if (!value.active) return;
  const receivedAt = performance.now();
  timer = setInterval(() => { elapsedSeconds.value = value.elapsedSeconds + (performance.now() - receivedAt) / 1000; }, 1000);
}, { immediate: true });
onScopeDispose(() => clearInterval(timer));
const elapsed = computed(() => t`${Math.floor(elapsedSeconds.value / 60)} 分 ${Math.floor(elapsedSeconds.value % 60)} 秒`);
</script>

<style scoped lang="scss">
.productionProgress {
  padding: 12px 16px 4px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--ui-radius-large);
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-lighter);
  font-size: 13px;

  .progressHeader {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-bottom: 8px;
    .progressTitle { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 500; line-height: 1.6; }
    .elapsed { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .statusDot { width: 6px; height: 6px; border-radius: 50%; background: var(--el-text-color-placeholder); flex-shrink: 0; }
    .statusDot.active { background: var(--el-color-primary); animation: statusPulse 1.8s ease-in-out infinite; }
  }

  .phaseDetails {
    summary { min-height: 40px; align-content: center; cursor: pointer; color: var(--el-text-color-secondary); font-size: 12px; border-radius: var(--ui-radius-small); }
    summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
    .phaseCount { float: right; font-variant-numeric: tabular-nums; }
    &[open] { padding-bottom: 8px; }
  }
  .progressDetails { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 8px; color: var(--el-text-color-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .phaseList {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px 16px;
    padding: 0;
    margin: 18px 0 0;
    list-style: none;
    li { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--el-text-color-secondary); font-size: 12px; }
    .phaseDot { width: 5px; height: 5px; margin: 0 4.5px; border-radius: 50%; background: var(--el-border-color); flex-shrink: 0; }
    .phaseStatus { margin-left: auto; font-size: 11px; color: var(--el-text-color-placeholder); white-space: nowrap; }
    .running { color: var(--el-color-primary); .phaseDot { background: currentColor; } .phaseStatus { color: inherit; } }
    .done svg { color: var(--el-color-primary); flex-shrink: 0; }
    .failed { color: var(--el-color-danger); .phaseStatus { color: inherit; } svg { flex-shrink: 0; } }
    @media (max-width: 560px) { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  }
  .progressHint { margin: 14px 0 0; color: var(--el-text-color-placeholder); font-size: 12px; line-height: 1.6; }
  .failureDetails { margin-bottom: 14px; color: var(--el-color-danger); summary { cursor: pointer; min-height: 40px; display: flex; align-items: center; } p { max-height: 160px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; } }
  .technicalDetails { color: var(--el-text-color-secondary); }
  &.completed { padding: 0; border: 0; box-shadow: none; background: transparent; .progressHeader { margin: 8px 0; } .progressTitle svg { color: var(--el-color-primary); } }
  &.failed .progressTitle svg { color: var(--el-color-danger); }
  @media (prefers-reduced-motion: reduce) { .progressHeader .statusDot.active { animation: none; } }
}
@keyframes statusPulse { 50% { opacity: 0.45; } }
</style>
