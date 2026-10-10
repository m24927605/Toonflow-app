import { IntlMessageFormat } from "intl-messageformat";
import { escapeMessageText } from "./messageText.ts";
export { escapeMessageText } from "./messageText.ts";
import zhTw from "./locales/zhTw.json";
import en from "./locales/en.json";

export type Locale = "zh-CN" | "zh-TW" | "en";
export interface MessageDescriptor { id: string; values?: Record<string, unknown> }
export const supportedLocales: { code: Locale; name: string }[] = [
  { code: "zh-CN", name: "简体中文" }, { code: "zh-TW", name: "繁體中文" }, { code: "en", name: "English" },
];
const catalogs: Record<string, Record<string, string>> = { "zh-TW": zhTw, en };
let activeLocale: Locale = "zh-CN";
const listeners = new Set<(locale: Locale) => void>();
const formatters = new Map<string, IntlMessageFormat>();

export function normalizeLocale(value: unknown): Locale | undefined {
  if (typeof value !== "string") return;
  let language: Intl.Locale;
  try { language = new Intl.Locale(value.trim().replaceAll("_", "-")); }
  catch { return; }
  if (language.language === "zh") {
    const script = language.maximize().script;
    if (script === "Hans") return "zh-CN";
    if (script === "Hant") return "zh-TW";
    return;
  }
  return language.language === "en" ? "en" : undefined;
}

export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const locale = normalizeLocale(language);
    if (locale) return locale;
  }
  return "en";
}

export function getLocale(): Locale { return activeLocale; }
export function setLocale(locale: Locale) {
  if (locale === activeLocale) return;
  activeLocale = locale;
  for (const listener of listeners) listener(locale);
}
export function subscribeLocale(listener: (locale: Locale) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function msg(strings: TemplateStringsArray, ...values: unknown[]): MessageDescriptor {
  if (!values.length) return { id: strings[0] };
  return {
    id: strings.map((part, index) => escapeMessageText(part) + (index < values.length ? `{${index}}` : "")).join(""),
    values: Object.fromEntries(values.map((value, index) => [index, value])),
  };
}

export function translate(message: string | MessageDescriptor, values?: Record<string, unknown>, language: Locale = activeLocale): string {
  const id = typeof message === "string" ? message : message.id;
  const parameters = values ?? (typeof message === "string" ? undefined : message.values);
  const catalog = Object.hasOwn(catalogs, language) ? catalogs[language] : undefined;
  const translated = catalog && Object.hasOwn(catalog, id) && typeof catalog[id] === "string" ? catalog[id] : id;
  if (!parameters || !Object.keys(parameters).length) return translated;
  const format = (text: string) => {
    const cacheKey = `${language}\0${text}`;
    let formatter = formatters.get(cacheKey);
    if (!formatter) {
      formatter = new IntlMessageFormat(text, language, undefined, { ignoreTag: true });
      // ACT: Dictionaries and language switching share a cache capped at 2000 entries;
      // it need not grow with user input.
      if (formatters.size >= 2000) formatters.delete(formatters.keys().next().value!);
      formatters.set(cacheKey, formatter);
    }
    const result = formatter.format(Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key,
      typeof value === "number" || value instanceof Date ? value : String(value),
    ])));
    return Array.isArray(result) ? result.join("") : String(result);
  };
  try { return format(translated); }
  catch {
    // ACT: Corrupt external language packs or ones missing parameters fall back to the source text;
    // parameters are substituted once and user input is not parsed again.
    try { return format(id); }
    catch { return id.replace(/\{(\d+)\}/g, (token, key) => Object.hasOwn(parameters, key) ? String(parameters[key]) : token); }
  }
}

export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return translate(msg(strings, ...values));
}
