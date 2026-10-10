<template>
  <div class="codexLogin">
    <div v-if="loggedIn" class="loginRow">
      <el-tag type="success" size="small">已登录 ChatGPT</el-tag>
      <el-button size="small" :loading="busy" @click="logout">退出登录</el-button>
    </div>
    <template v-else>
      <div class="loginRow">
        <el-button type="primary" size="small" :loading="busy" @click="login">登录 ChatGPT</el-button>
        <el-link v-if="authUrl" :href="authUrl" target="_blank" rel="noopener noreferrer" type="primary">打开登录页面</el-link>
        <el-text v-if="pending" type="info" size="small">等待浏览器完成登录…</el-text>
      </div>
      <form v-if="authUrl" class="codeForm" @submit.prevent="submitCode">
        <el-input v-model="code" size="small" placeholder="浏览器未自动完成时，粘贴跳转后的网址" aria-label="跳转后的网址或授权码" />
        <el-button size="small" nativeType="submit" :loading="busy" :disabled="!code.trim()">提交</el-button>
      </form>
    </template>
    <el-text v-if="error" type="danger" size="small" role="alert">{{ error }}</el-text>
  </div>
</template>

<script setup lang="ts">
import axios from "axios";
import { onBeforeUnmount, ref, watch } from "vue";

const { active = true } = defineProps<{ active?: boolean }>();
const loggedIn = defineModel<boolean>("loggedIn", { default: false });
const headers = { "x-toonflow-workspace": "1" };
const authUrl = ref("");
const code = ref("");
const error = ref("");
const pending = ref(false);
const busy = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function errorMessage(value: unknown, fallback: string) {
  return axios.isAxiosError(value) ? value.response?.data?.message || fallback : value instanceof Error ? value.message : fallback;
}

async function refresh() {
  clearTimeout(timer);
  try {
    const { data } = await axios.get("/api/ai/codex/status", { headers });
    loggedIn.value = data.data.loggedIn === true;
    pending.value = data.data.pending === true;
    error.value = data.data.error || "";
    if (loggedIn.value) authUrl.value = code.value = "";
    // Poll only while a login is pending so the local OAuth callback can finish without further clicks.
    if (pending.value && active) timer = setTimeout(refresh, 2000);
  } catch (value) {
    error.value = errorMessage(value, "读取登录状态失败");
  }
}

watch(() => active, value => {
  if (value) void refresh();
  else clearTimeout(timer);
}, { immediate: true });
onBeforeUnmount(() => clearTimeout(timer));

async function login() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const { data } = await axios.post("/api/ai/codex/login", null, { headers, timeout: 30000 });
    authUrl.value = data.data.url;
    // The link stays visible in case the browser blocks this popup.
    window.open(authUrl.value, "_blank", "noopener");
    await refresh();
  } catch (value) {
    error.value = errorMessage(value, "无法开始登录，请重试");
  } finally {
    busy.value = false;
  }
}

async function submitCode() {
  if (busy.value || !code.value.trim()) return;
  busy.value = true;
  error.value = "";
  try {
    await axios.post("/api/ai/codex/code", { code: code.value.trim() }, { headers, timeout: 60000 });
    await refresh();
  } catch (value) {
    error.value = errorMessage(value, "登录失败，请重新登录");
  } finally {
    busy.value = false;
  }
}

async function logout() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await axios.post("/api/ai/codex/logout", null, { headers });
    await refresh();
  } catch (value) {
    error.value = errorMessage(value, "退出登录失败，请重试");
  } finally {
    busy.value = false;
  }
}
</script>

<style lang="scss" scoped>
.codexLogin {
  display: flex;
  flex-direction: column;
  gap: 8px;

  .loginRow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .codeForm {
    display: flex;
    gap: 8px;
  }
}
</style>
