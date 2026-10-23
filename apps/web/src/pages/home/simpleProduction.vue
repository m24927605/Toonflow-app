<template>
  <div class="chatLayout">
  <aside class="chatSidebar" aria-label="聊天記錄">
    <slot name="mode" />
    <el-button class="newChatButton" :disabled="submitting" @click="openChat()">新聊天</el-button>
    <nav class="chatHistory" aria-label="聊天記錄">
      <button v-for="entry in [...productions].reverse()" :key="entry.id" class="chatHistoryItem" :class="{ selected: selectedId === entry.id }" :title="entry.outline" :aria-current="selectedId === entry.id ? 'page' : undefined" :disabled="submitting" @click="openChat(entry.id)">
        <span class="chatTitle">{{ entry.outline }}</span>
        <span v-if="entry.progress.active" class="chatActivity">製作中</span>
      </button>
    </nav>
    <div class="sidebarSettings"><slot name="settings" /></div>
  </aside>
  <section class="simpleProduction" aria-label="簡易模式">
    <header v-if="!entries.length && !loading" class="conversationHeader">
      <h1>Toonflow</h1>
      <p>說說你的想法，或直接告訴 AI 想製作的影片。</p>
    </header>
    <div ref="conversation" class="conversation" role="log" aria-label="影片製作對話" aria-live="polite" :aria-busy="loading">
      <article v-for="entry in entries" :key="entry.id" class="conversationEntry">
        <div v-if="entry.hasProduction && !entry.fromConversation" class="storyMessage"><span class="speaker">你</span><p>{{ entry.outline }}</p></div>
        <div v-for="note in entry.clarifications" :key="note.at" class="storyMessage"><span class="speaker">你的補充</span><p>{{ note.message }}</p></div>
        <template v-for="turn in turns" :key="turn.id">
          <div class="storyMessage"><span class="speaker">你</span><p>{{ turn.message }}</p><attachmentList v-if="turn.attachments?.length" :attachments="turn.attachments" :directory="directory" /></div>
          <div class="productionMessage">
            <span class="speaker">{{ turn.started || turn.notice ? '製作通知' : 'Toonflow' }}</span>
            <p v-if="turn.reply">{{ turn.reply }}</p>
            <p v-else-if="turn.status === 'pending'" role="status">AI 正在理解內容或準備回覆…</p>
            <p v-if="turn.status === 'failed'" class="errorMessage" role="alert">{{ turn.error }}</p>
            <el-button v-if="turn.status === 'failed'" text :disabled="submitting || replyPending" @click="send(turn.productionRequested ? 'start' : 'chat', turn)">重送</el-button>
            <p v-if="turn.change">本次調整：{{ turn.change.text }}</p>
            <p v-if="turn.change" class="changeState">{{ turn.change.status === 'applied' ? '調整已寫入製作內容。' : turn.change.status === 'draft' ? '調整已記錄，要求開始或接續製作後才會套用。' : entry.status === 'failed' || entry.status === 'waiting' ? '調整尚未完成，可接續製作。' : turn.change.status === 'queued' ? '調整已排入，會在目前步驟完成後套用。' : '正在套用調整，原始檔案仍會保留。' }}</p>
          </div>
        </template>
        <div v-if="entry.hasProduction" class="productionMessage">
          <span class="speaker">Toonflow</span>
          <productionProgress v-if="entry.id !== currentEntry?.id" :progress="entry.progress" :label="statusText(entry)" :failed="entry.status === 'failed' || entry.status === 'waiting' || entry.progress.cleanupStatus === 'failed'" />
          <productionContext v-if="directory" :directory="directory" :id="entry.id" :active="entry.progress.active" :status="entry.status" />
          <div v-if="entry.guidance && !entry.progress.active" class="recoveryGuide">
            <p>{{ entry.guidance.summary }}</p>
            <p class="recoveryQuestion">{{ entry.guidance.question }}</p>
            <div v-if="entry.guidance.retryable" class="recoverySuggestions">
              <el-button v-for="suggestion in entry.guidance.suggestions" :key="suggestion" plain :disabled="busy" @click="beginClarification(entry, suggestion)">{{ suggestion }}</el-button>
            </div>
            <div class="recoveryActions">
              <template v-if="entry.guidance.retryable">
                <el-button v-if="entry.guidance.canRetry" type="primary" plain :loading="resolving === entry.id" :disabled="busy" @click="resolve(entry.id, 'retry')">讓 AI 檢查並繼續</el-button>
                <el-button text :disabled="busy" @click="beginClarification(entry)">補充要求</el-button>
              </template>
              <el-button v-else :disabled="busy" @click="beginNewStory(entry)">調整故事另建製作</el-button>
            </div>
          </div>
          <template v-if="entry.progress.finished && filmUrls[entry.id]">
            <videoPlayer :src="filmUrls[entry.id]!" label="觀看成片" readOnly />
            <a :href="filmUrls[entry.id]" :download="`${entry.id}.mp4`">下載影片</a>
          </template>
        </div>
      </article>
    </div>
    <div class="composerDock">
    <p v-if="error" class="errorMessage" role="alert">{{ error }}</p>
    <p v-if="refreshError" class="errorMessage" role="alert">{{ refreshError }}</p>
    <productionProgress v-if="currentEntry?.hasProduction" :progress="currentEntry.progress" :label="statusText(currentEntry)" :failed="currentEntry.status === 'failed' || currentEntry.status === 'waiting' || currentEntry.progress.cleanupStatus === 'failed'" />
    <form class="storyComposer" @submit.prevent="send('chat')">
      <div v-if="recoveryTarget" class="recoveryContext"><span>補充這支影片的製作要求</span><el-button text :disabled="submitting" @click="openChat()">返回新聊天</el-button></div>
      <attachmentList v-if="draftAttachments.length" class="draftAttachments" :attachments="draftAttachments" :directory="directory" removable :disabled="submitting" @remove="draftAttachments.splice($event, 1)" />
      <el-input ref="storyInput" v-model="story" type="textarea" :autosize="{ minRows: 1, maxRows: 6 }" :maxlength="20000" resize="none" placeholder="與 AI 聊聊，或說明想調整的內容…" aria-label="與 AI 對話" @keydown.ctrl.enter.prevent="send('chat')" @keydown.meta.enter.prevent="send('chat')" />
      <input ref="attachmentInput" type="file" hidden multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/wav,audio/mpeg,audio/mp4,audio/ogg,audio/flac,audio/aac,audio/webm" @change="addAttachments" />
      <div class="composerActions">
        <el-button class="attachButton" :icon="IconPaperclip" :disabled="submitting" aria-label="上傳圖片、影片或音訊參考" title="上傳參考素材" @click="attachmentInput?.click()" />
        <el-button nativeType="submit" :loading="submitting && pendingMessage?.action === 'chat'" :disabled="submitting || replyPending || (!story.trim() && !draftAttachments.length)">聊天</el-button>
        <el-button type="primary" :loading="submitting && pendingMessage?.action === 'start'" :disabled="submitting || replyPending || (!story.trim() && !selectedId && !draftAttachments.length)" @click="send('start')">開始製作</el-button>
      </div>
    </form>
    </div>
  </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import axios from "axios";
import { locale, t, translate } from "@toonflow/i18n/vue";
import { ElButton, ElInput, type InputInstance } from "element-plus";
import videoPlayer from "@toonflow/node-video/videoPlayer";
import { IconPaperclip } from "@tabler/icons-vue";
import attachmentList from "@/components/agent/attachmentList.vue";
import { uploadAttachments } from "@/components/agent/attachmentUploads";
import type { AgentAttachment } from "@/components/agent/types";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import productionContext from "./productionContext.vue";
import productionProgress, { type ProductionProgress } from "./productionProgress.vue";

type Entry = { id: string; hasProduction: boolean; fromConversation: boolean; outline: string; createdAt: string; status: "chatting" | "running" | "waiting" | "failed" | "done"; message?: string; stage?: string; film?: string; progress: ProductionProgress; clarifications: { at: string; message: string }[]; guidance?: { summary: string; question: string; suggestions: string[]; retryable: boolean; canRetry: boolean } };
type Turn = { id: string; message: string; attachments?: AgentAttachment[]; productionRequested?: true; status: "pending" | "answered" | "failed"; started?: boolean; notice?: boolean; reply?: string; error?: string; change?: { text: string; status: "draft" | "queued" | "applying" | "applied" } };
const emit = defineEmits<{ runningChange: [running: boolean] }>();
const story = ref("");
const storyInput = ref<InputInstance>();
const attachmentInput = ref<HTMLInputElement>();
const draftAttachments = ref<AgentAttachment[]>([]);
const conversation = ref<HTMLElement>();
const recoveryTarget = ref<string>();
const resolving = ref<string>();
const productions = ref<Entry[]>([]);
const turns = ref<Turn[]>([]);
const replyPending = computed(() => turns.value.some(turn => turn.status === "pending"));
const selectedId = ref<string>();
const entries = computed(() => productions.value.filter(entry => entry.id === selectedId.value));
const loading = ref(false);
const submitting = ref(false);
const error = ref("");
const refreshError = ref("");
const revision = ref(0);
const directory = ref("");
const filmUrls = ref<Record<string, string>>({});
const currentEntry = computed(() => entries.value.find(entry => entry.progress.active) ?? entries.value.at(-1));
const busy = computed(() => submitting.value || productions.value.some(entry => entry.progress.active));
const headers = { "x-toonflow-workspace": "1" };
type PendingMessage = { id: string; productionId: string; text: string; action: "chat" | "start"; attachments: AgentAttachment[] };
const pendingMessage = ref<PendingMessage>();
let disposed = false;
onScopeDispose(() => { disposed = true; });
onMounted(() => storyInput.value?.focus());
watch(() => entries.value.at(-1)?.id, async () => {
  await nextTick();
  if (conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight;
});
watch(() => {
  const turn = turns.value.at(-1);
  return turn ? [turn.id, turn.status, turn.reply, turn.change?.status].join(":") : "";
}, async () => {
  const log = conversation.value;
  const nearBottom = log && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  await nextTick();
  if (nearBottom && conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight;
});
watch(() => busy.value || loading.value, value => emit("runningChange", value), { immediate: true });

const stageLabels: Record<string, string> = {
  references: "安排參考素材", startupPlan: "準備製作資源", startupText: "準備製作資源", startupMedia: "準備畫面與聲音模型",
  direction: "規劃影片", script: "撰寫劇本", scriptRevision: "調整劇本與製作規格", shotList: "安排分鏡", cast: "設計角色與場景", contractPlan: "檢查製作規格",
  dialogueTimingRepair: "協調配音與分鏡時間", executionPlan: "安排製作流程", plan: "安排鏡頭", designs: "製作角色與場景圖片",
  previsRender: "製作鏡頭引導", poses: "調整人物姿勢", dub: "製作配音", texts: "準備影片描述",
  ambience: "製作環境音", music: "製作背景音樂",
  promptTiming: "對齊畫面與聲音", clips: "生成影片", roughCut: "剪輯影片", film: "完成後製",
  deliveryValidation: "檢查成片", report: "準備交付",
};

function statusText(entry: Entry) {
  if (entry.progress.cleanupStatus === "running") return !entry.progress.active ? translate("目前無法確認收尾進度，尚未交付成片。") : entry.status === "done" ? translate("成片已產出，正在完成收尾。") : translate("製作中斷，正在釋放製作資源。");
  if (entry.progress.cleanupStatus === "failed") return translate("製作資源清理未完成，尚未確認製作完成。");
  if (entry.status === "done") return entry.progress.finished ? filmUrls.value[entry.id] ? translate("影片已完成。") : translate("正在載入成片。") : translate("收尾狀態尚未確認，尚未交付成片。");
  if (entry.guidance && !entry.progress.active) return entry.guidance.summary;
  if (entry.status === "failed" || entry.status === "waiting") {
    if (entry.message === "budget") return translate("這次製作已達系統的資源額度，未能完成影片。");
    return translate("這次製作未能完成，沒有交付影片。");
  }
  if (!entry.progress.active) return translate("目前無法確認製作進度，尚未交付成片。");
  if (entry.progress.phases.find(phase => phase.id === "preparation")?.status === "running" && entry.stage === "clips") return translate("正在準備畫面與聲音的製作資源。");
  return t`AI 正在${translate(stageLabels[entry.stage ?? ""] ?? "製作影片")}，完成後會在這裡交付。`;
}

watch([revision, locale, selectedId], (values, previousValues, onCleanup) => {
  const controller = new AbortController();
  const resources = new Map<string, ReturnType<ReturnType<typeof useWorkspaceFiles>["acquireUrl"]>>();
  let timer: ReturnType<typeof setTimeout>;
  onCleanup(() => {
    controller.abort();
    clearTimeout(timer);
    resources.forEach(item => item.release());
  });
  filmUrls.value = {};
  if (values.at(2) !== previousValues?.at(2)) turns.value = [];
  refreshError.value = "";
  loading.value = true;
  async function refresh() {
    try {
      const { data } = await axios.get<{ code: number; data: { directory: string; productions: Entry[] }; message: string }>("/api/production/simple/list", { headers, signal: controller.signal, timeout: 15000 });
      controller.signal.throwIfAborted();
      if (data.code !== 200) throw new Error(data.message);
      directory.value = data.data.directory;
      productions.value = data.data.productions;
      if (selectedId.value) {
        const response = await axios.get<{ data: { turns: Turn[] } }>("/api/production/simple/conversation", { headers: { ...headers, "Accept-Language": locale.value }, params: { id: selectedId.value }, signal: controller.signal, timeout: 15000 });
        controller.signal.throwIfAborted();
        turns.value = response.data.data.turns;
        if (pendingMessage.value && turns.value.some(turn => turn.id === pendingMessage.value!.id)) {
          clearSentDraft(pendingMessage.value);
          pendingMessage.value = undefined;
        }
      }
      if (!pendingMessage.value) error.value = "";
      refreshError.value = "";
      for (const entry of entries.value) {
        if (!entry.film || resources.has(entry.id)) continue;
        const resource = useWorkspaceFiles(data.data.directory).acquireUrl(entry.film, "video/mp4");
        resources.set(entry.id, resource);
        void resource.url.then(url => {
          if (!controller.signal.aborted) filmUrls.value[entry.id] = url;
        }).catch(() => {
          if (controller.signal.aborted) return;
          resource.release();
          resources.delete(entry.id);
          error.value = "成片讀取失敗，請重新整理頁面以重試。";
        });
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      refreshError.value = axios.isAxiosError(cause) ? cause.response?.data?.message || "暫時無法取得製作進度，正在重新連線。" : cause instanceof Error ? cause.message : "讀取製作進度失敗。";
    } finally {
      if (!controller.signal.aborted) {
        loading.value = false;
        if (productions.value.some(entry => entry.progress.active) || replyPending.value || error.value || refreshError.value) timer = setTimeout(refresh, 3000);
      }
    }
  }
  void refresh();
}, { immediate: true });

async function openChat(id?: string) {
  if (submitting.value) return;
  selectedId.value = id;
  recoveryTarget.value = undefined;
  story.value = "";
  draftAttachments.value = [];
  pendingMessage.value = undefined;
  error.value = "";
  await nextTick();
  storyInput.value?.focus();
}

async function beginClarification(entry: Entry, suggestion = "") {
  if (busy.value) return;
  recoveryTarget.value = entry.id;
  story.value = suggestion;
  await nextTick();
  storyInput.value?.focus();
}

async function beginNewStory(entry: Entry) {
  await openChat();
  story.value = entry.outline;
  await nextTick();
  storyInput.value?.focus();
}

async function resolve(id: string, action: "retry" | "clarify", message?: string) {
  if (busy.value) return;
  submitting.value = true;
  resolving.value = id;
  error.value = "";
  try {
    await axios.post("/api/production/simple/resolve", { id, action, message }, { headers });
    if (action === "clarify") story.value = "";
    recoveryTarget.value = undefined;
    revision.value++;
  } catch (cause) {
    error.value = axios.isAxiosError(cause) ? cause.response?.data?.message || "暫時無法接續製作，請稍後再試。" : cause instanceof Error ? cause.message : "無法送出調整。";
  } finally { submitting.value = false; resolving.value = undefined; }
}

function clearSentDraft(request: PendingMessage) {
  if (story.value.trim() === request.text) story.value = "";
  draftAttachments.value = draftAttachments.value.filter(item => !request.attachments.includes(item));
}

function addAttachments(event: Event) {
  const input = event.target as HTMLInputElement;
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac" };
  for (const file of Array.from(input.files ?? [])) {
    const mimeType = Object.values(types).includes(file.type) || file.type === "audio/webm" ? file.type : types[file.name.split(".").at(-1)?.toLowerCase() ?? ""];
    if (!mimeType || !file.size || file.size > 100 * 1024 * 1024) { error.value = translate("請選擇有效的圖片、影片或音訊，每個檔案不得超過 100 MB。"); continue; }
    const stored = new Set(turns.value.flatMap(turn => turn.attachments ?? []).map(item => item.path)).size;
    if (stored + draftAttachments.value.length >= 10) { error.value = translate("每段聊天最多使用 10 個參考附件。"); break; }
    draftAttachments.value.push({ name: file.name, path: "", mimeType, file });
  }
  input.value = "";
  storyInput.value?.focus();
}

async function send(action: "chat" | "start", source?: Turn) {
  const text = (source?.message ?? story.value.trim()) || (action === "start" ? "請按照目前討論的內容開始製作影片。" : "請參考上傳的素材。");
  if (submitting.value || replyPending.value || disposed || (!source && action === "chat" && !story.value.trim() && !draftAttachments.value.length)) return;
  const productionId = recoveryTarget.value ?? selectedId.value ?? (pendingMessage.value?.text === text ? pendingMessage.value.productionId : crypto.randomUUID());
  const attachments = source?.attachments ?? draftAttachments.value.slice();
  const previous = pendingMessage.value;
  const sameMessage = previous?.text === text && previous.productionId === productionId && previous.action === action && (!source || previous.id === source.id);
  const sameAttachments = previous?.attachments.length === attachments.length && previous.attachments.every(item => attachments.some(other => other === item || !!item.path && other.path === item.path));
  if (!sameMessage || !sameAttachments) pendingMessage.value = { id: source?.id ?? crypto.randomUUID(), productionId, text, action, attachments };
  const request = pendingMessage.value!;
  submitting.value = true;
  error.value = "";
  selectedId.value = productionId;
  try {
    if (!directory.value) throw new Error(translate("工作區尚未載入，請稍後重試；輸入與附件仍會保留。"));
    await uploadAttachments(request.attachments, directory.value, `assets/chat/conversation${request.productionId.replaceAll("-", "")}`);
    await axios.post("/api/production/simple/message", { id: request.productionId, messageId: request.id, message: request.text, action: request.action, attachments: request.attachments.map(({ name, path, mimeType }) => ({ name, path, mimeType })) }, { headers: { ...headers, "Accept-Language": locale.value }, timeout: 15000 });
    selectedId.value = request.productionId;
    if (!source) clearSentDraft(request);
    recoveryTarget.value = undefined;
    pendingMessage.value = undefined;
    revision.value++;
  } catch (cause) {
    error.value = axios.isAxiosError(cause) ? cause.response?.data?.message || "訊息送出狀態未確認，重送會沿用同一則訊息。" : cause instanceof Error ? cause.message : "無法送出訊息。";
    revision.value++;
  } finally {
    submitting.value = false;
    await nextTick();
    if (!disposed) storyInput.value?.focus();
  }
}

</script>

<style scoped lang="scss">
.chatLayout {
  display: flex;
  height: 100%;
  min-height: 0;
  gap: clamp(16px, 3vw, 40px);
  .chatSidebar {
    display: flex;
    flex-direction: column;
    width: clamp(140px, 22vw, 240px);
    flex-shrink: 0;
    gap: 16px;
    padding: 4px 12px 4px 0;
    border-right: 1px solid var(--el-border-color-lighter);
    .newChatButton { min-height: 40px; margin: 0; }
    .chatHistory {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      .chatHistoryItem {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 44px;
        padding: 10px;
        margin-bottom: 4px;
        border: 0;
        border-radius: var(--ui-radius-large);
        background: transparent;
        color: var(--el-text-color-regular);
        font: inherit;
        font-size: 13px;
        text-align: left;
        cursor: pointer;
        &:hover, &.selected { background: var(--el-fill-color-light); }
        &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
        &:disabled { cursor: wait; opacity: 0.6; }
        .chatTitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .chatActivity { flex-shrink: 0; font-size: 12px; color: var(--el-color-primary); }
      }
    }
    .sidebarSettings {
      padding-top: 12px;
      border-top: 1px solid var(--el-border-color-lighter);
      :deep(.el-button) { height: 44px; width: 100%; justify-content: flex-start; padding: 0 14px; font-size: 14px; font-weight: 500; }
      :deep(.el-button.is-disabled) { color: var(--el-text-color-secondary); background: var(--el-fill-color-light); border-color: var(--el-border-color-light); }
    }
  }
}
.simpleProduction {
  width: min(780px, 100%);
  height: 100%;
  min-height: 0;
  min-width: 0;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;

  .conversationHeader {
    text-align: center;
    padding: 20px 0;
    h1 { margin: 0 0 12px; font-size: 36px; letter-spacing: -1px; }
    p { margin: 0; color: var(--el-text-color-secondary); line-height: 1.7; }
  }

  .conversation {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
    scrollbar-gutter: stable;
    .conversationEntry {
      display: flex;
      flex-direction: column;
      gap: 20px;
      margin-bottom: 32px;
      .changeState { color: var(--el-text-color-secondary); font-size: 12px; }
      .speaker { font-size: 12px; color: var(--el-text-color-secondary); }
      p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin: 8px 0; }
      .storyMessage { align-self: flex-end; max-width: 85%; padding: 14px 20px; border-radius: 18px; background: var(--el-fill-color-light); }
      .productionMessage {
        width: 100%;
        :deep(.videoPlayer) { border-radius: 12px; overflow: hidden; }
        a { display: inline-block; margin-top: 12px; color: var(--el-color-primary); }
        .recoveryGuide {
          margin-top: 16px;
          padding: 16px;
          border-radius: var(--ui-radius-large);
          background: var(--el-fill-color-extra-light);
          .recoveryQuestion { color: var(--el-text-color-secondary); font-size: 13px; }
          .recoverySuggestions { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
          .recoverySuggestions .el-button { height: auto; min-height: 40px; white-space: normal; margin: 0; text-align: left; line-height: 1.6; }
          .recoveryActions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; .el-button { min-height: 40px; margin: 0; } }
        }
      }
    }
  }

  .errorMessage { color: var(--el-color-danger); line-height: 1.6; margin: 0; }
  .composerDock {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    min-height: 0;
    max-height: 60%;
    gap: 12px;
    > .productionProgress { min-height: 0; max-height: min(240px, 30dvh); overflow-y: auto; overscroll-behavior-y: contain; scrollbar-gutter: stable; }
  }
  .storyComposer {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex-shrink: 1;
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color-light);
    border-radius: 16px;
    padding: 16px;
    box-shadow: var(--el-box-shadow-lighter);
    :deep(.el-textarea) { display: flex; flex-direction: column; min-height: 0; }
    :deep(.el-textarea__inner) { min-height: 0 !important; max-height: 100%; overflow-y: auto; box-shadow: none; background: transparent; padding: 0; line-height: 1.8; }
    .recoveryContext { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; color: var(--el-text-color-secondary); font-size: 12px; .el-button { min-height: 40px; } }
    .draftAttachments { max-height: 96px; overflow-y: auto; margin-bottom: 12px; }
    .composerActions { display: flex; flex-shrink: 0; justify-content: flex-end; gap: 8px; margin-top: 12px; .el-button { margin-left: 0; } .attachButton { margin-right: auto; } }
  }
}
</style>
