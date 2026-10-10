import type { Locale } from "./index";
import zhCn from "./elementPlus/zhCn.json";
import zhTw from "./elementPlus/zhTw.json";
import en from "./elementPlus/en.json";

export const elementLocales = {
  "zh-CN": zhCn, "zh-TW": zhTw, en,
} satisfies Record<Locale, typeof en>;
