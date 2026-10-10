import { createApp, h, nextTick } from "vue";
import { ElButton, ElResult } from "element-plus";
import { createPinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";
import App from "./App.vue";
import "@/assets/main.scss";
import "element-plus/es/components/message-box/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/result/style/css";

import router from "@/router";
import { registerDesktopProtocol } from "@/lib/desktopProtocol";
import { registerDownloads } from "@/lib/saveFile";
import { loadSettings, settingsStorage } from "@/stores/settings";
import { registerLanguage } from "@/lib/i18n";
import { locale, translate } from "@toonflow/i18n/vue";

const app = createApp(App);
app.onUnmount(registerLanguage());
const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
const requiresWebView2Update = isDesktop && /Windows/i.test(navigator.userAgent)
  && [Map.groupBy, URL.canParse, Promise.withResolvers].some(method => typeof method !== "function");
let isMounted = false;

async function notifyDesktopReady(failed = false) {
  if (!isDesktop) return;
  const response = await fetch("/api/desktop/ready", {
    method: "POST",
    headers: { "x-toonflow-desktop": "1", "Content-Type": "application/json", "Accept-Language": locale.value },
    body: JSON.stringify({ failed }),
  });
  if (!response.ok) throw new Error((await response.json()).message || `通知桌面就绪失败（${response.status}）`);
}

// ACT: At startup, keep an old WebView2 that lacks required APIs out of app pages.
(requiresWebView2Update
  ? Promise.reject(new Error("当前 Microsoft Edge WebView2 Runtime 版本过旧。请以管理员身份运行微软最新版安装器；若仍提示已安装，请修复 WebView2 或联系管理员检查更新服务。更新完成后，请完全退出 Toonflow 再重新打开。"))
  : loadSettings()).then(async () => {
  app.use(createPinia().use(createPersistedState({ storage: settingsStorage })));
  app.use(router);
  await router.isReady();
  app.mount("#app");
  isMounted = true;
  app.onUnmount(registerDownloads());
  if (!isDesktop) return;
  app.onUnmount(registerDesktopProtocol());
  await nextTick();
  // ACT: A hidden WebView can't rely on requestAnimationFrame; wait for the home page to mount and resources to load.
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
  }
  await notifyDesktopReady();
}).catch(async (error) => {
  console.error("页面初始化失败：", error);
  if (isMounted) app.unmount();
  createApp({
    render: () => h(ElResult, {
      icon: "error",
      title: requiresWebView2Update ? translate("需要更新 WebView2") : translate("启动失败"),
      subTitle: error instanceof Error ? error.message : translate("无法加载应用，请重试。"),
    }, {
      extra: () => h(ElButton, {
        type: "primary",
        onClick: () => requiresWebView2Update
          ? window.open("https://developer.microsoft.com/microsoft-edge/webview2/#download", "_blank")
          : window.location.reload(),
      }, () => requiresWebView2Update ? translate("前往微软官网更新") : translate("重试")),
    }),
  }).mount("#app");
  await nextTick();
  // ACT: The error page also ends the startup animation but mustn't consume install requests before listeners register.
  await notifyDesktopReady(true).catch((error) => console.error("显示启动错误页失败：", error));
});
