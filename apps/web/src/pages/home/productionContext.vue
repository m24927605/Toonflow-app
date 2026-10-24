<template>
  <section class="productionContext" aria-label="實際製作內容" :aria-busy="loading">
    <h3>實際製作內容</h3>
    <p class="contextHint">以下是這支影片實際產生的內容，會隨製作更新；你不需要逐項確認。</p>
    <p v-if="error" class="contextError" role="alert">{{ error }}</p>
    <p v-else-if="!context">正在讀取製作內容…</p>
    <template v-if="context">
      <details open>
        <summary>劇本與人物設定</summary>
        <messageMarkdown v-if="context.script" :content="context.script" />
        <p v-else>劇本尚未產生。</p>
      </details>
      <div class="referenceGrid">
        <article v-for="item in references" :key="item.key" class="referenceCard">
          <div class="referenceHeading"><h4>{{ item.name }}</h4><span>{{ item.kind }}</span></div>
          <div v-if="item.paths.length" class="referenceImages">
            <el-image v-for="path in item.paths" :key="path" :src="imageUrls[path]" :alt="item.name" fit="contain" :previewSrcList="item.paths.flatMap(path => imageUrls[path] ? [imageUrls[path]!] : [])" :initialIndex="item.paths.filter(path => imageUrls[path]).indexOf(path)" hideOnClickModal previewTeleported>
              <template #placeholder><span>圖片載入中…</span></template>
              <template #error><span>圖片讀取失敗</span></template>
            </el-image>
          </div>
          <p v-else>圖片尚未產生。</p>
        </article>
      </div>
      <p v-if="!references.length">人物與場景圖片設定尚未產生。</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import { ElImage } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import messageMarkdown from "@/components/messageMarkdown.vue";

type Asset = { name: string; base?: string; views?: string[]; outfits?: { name: string; views?: string[] }[] };
type ProductionContext = { script?: string; production: { id: string; toonflowProduction: number; assets?: { characters: Asset[]; places: Asset[] } } };
const props = defineProps<{ directory: string; id: string; active: boolean; status: string }>();
const context = ref<ProductionContext>();
const loading = ref(false);
const error = ref("");
const imageUrls = ref<Record<string, string>>({});
const references = computed(() => {
  const production = context.value?.production;
  if (!production?.assets) return [];
  return [
    ...production.assets.characters.flatMap(item => [
      { key: `character:${item.name}`, name: item.name, kind: translate("人物參考"), paths: item.views ?? (item.base ? [item.base] : []) },
      ...(item.outfits ?? []).map((outfit, index) => ({ key: `outfit:${item.name}:${index}`, name: `${item.name} · ${outfit.name}`, kind: translate("服裝參考"), paths: outfit.views ?? [] })),
    ]),
    ...production.assets.places.map(item => ({ key: `place:${item.name}`, name: item.name, kind: translate("空景參考"), paths: item.views ?? (item.base ? [item.base] : []) })),
  ];
});

watch(() => [props.directory, props.id, props.active, props.status] as const, (_value, _previous, onCleanup) => {
  const controller = new AbortController();
  const resources = new Map<string, ReturnType<ReturnType<typeof useWorkspaceFiles>["acquireUrl"]>>();
  let timer: ReturnType<typeof setTimeout>;
  context.value = undefined;
  imageUrls.value = {};
  onCleanup(() => { controller.abort(); clearTimeout(timer); resources.forEach(item => item.release()); });
  async function refresh() {
    loading.value = true;
    try {
      const { data } = await axios.get<{ code: number; message: string; data: ProductionContext }>("/api/production/get", { params: { directory: props.directory, id: props.id }, signal: controller.signal });
      controller.signal.throwIfAborted();
      if (data.code !== 200) throw new Error(data.message);
      if (data.data.production.toonflowProduction !== 1 || data.data.production.id !== props.id) throw new Error(translate("製作內容與目前影片不符。"));
      context.value = data.data;
      error.value = "";
      controller.signal.throwIfAborted();
      const paths = new Set([...references.value.flatMap(item => item.paths)]);
      for (const [path, resource] of resources) if (!paths.has(path)) { resource.release(); resources.delete(path); delete imageUrls.value[path]; }
      await Promise.all([...paths].map(async path => {
        if (resources.has(path)) return;
        const resource = useWorkspaceFiles(props.directory).acquireUrl(path);
        resources.set(path, resource);
        try { const url = await resource.url; if (!controller.signal.aborted) imageUrls.value[path] = url; }
        catch { resource.release(); resources.delete(path); }
      }));
    } catch (cause) {
      if (!controller.signal.aborted) error.value = translate("製作內容讀取失敗，請重新整理頁面重試。");
    } finally {
      if (!controller.signal.aborted) {
        loading.value = false;
        if (props.active) timer = setTimeout(refresh, 5000);
      }
    }
  }
  void refresh();
}, { immediate: true });
</script>

<style scoped lang="scss">
.productionContext {
  margin-top: 16px;
  padding: 16px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--ui-radius-large);
  font-size: 13px;
  h3 { margin: 0; font-size: 14px; font-weight: 500; }
  .contextHint { color: var(--el-text-color-secondary); }
  .contextError { color: var(--el-color-danger); }
  details { margin: 16px 0; summary { cursor: pointer; min-height: 40px; line-height: 40px; } }
  .referenceGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 16px; }
  .referenceCard { min-width: 0; .referenceHeading { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; h4 { margin: 0; font-size: 13px; } span { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; } } }
  .referenceImages { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; .el-image { flex: 1; min-width: 100px; height: 220px; border-radius: var(--el-border-radius-base); background: var(--el-fill-color-extra-light); border: 1px solid var(--el-border-color-lighter); } span { display: grid; place-items: center; height: 100%; color: var(--el-text-color-secondary); } }
}
</style>
