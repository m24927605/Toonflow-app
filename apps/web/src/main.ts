import { createApp, h } from "vue";
import { ElButton, ElResult } from "element-plus";
import { createPinia } from "pinia";
import { createPersistedState } from "pinia-plugin-persistedstate";
import App from "./App.vue";
import "@/assets/main.scss";
import "element-plus/es/components/message-box/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/result/style/css";

import router from "@/router";
import { guardGenerations } from "@/lib/generationGuard";
import { loadSettings, settingsStorage } from "@/stores/settings";
import { registerLanguage } from "@/lib/i18n";
import { translate } from "@toonflow/i18n/vue";
import logoUrl from "@toonflow/assets/logo.svg";

// The browser tab shows the same logo as the home page.
document.head.append(Object.assign(document.createElement("link"), { rel: "icon", type: "image/svg+xml", href: logoUrl }));

const app = createApp(App);
app.onUnmount(registerLanguage());
let isMounted = false;

loadSettings().then(async () => {
  app.use(createPinia().use(createPersistedState({ storage: settingsStorage })));
  app.use(router);
  guardGenerations(router);
  await router.isReady();
  app.mount("#app");
  isMounted = true;
}).catch((error) => {
  console.error("页面初始化失败：", error);
  if (isMounted) app.unmount();
  createApp({
    render: () => h(ElResult, {
      icon: "error",
      title: translate("启动失败"),
      subTitle: error instanceof Error ? error.message : translate("无法加载应用，请重试。"),
    }, {
      extra: () => h(ElButton, { type: "primary", onClick: () => window.location.reload() }, () => translate("重试")),
    }),
  }).mount("#app");
});
