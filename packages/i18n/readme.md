# Toonflow Internationalization

[Back to project home](../../README.md) · [Documentation index](../../docs/readme.md) · [Development and Extension Guide](../../docs/development.md)

Language dictionaries live in `src/locales/`. Three locales are supported: English (`en`, `en.json`), Traditional Chinese (`zh-TW`, `zhTw.json`) and Simplified Chinese (`zh-CN`, `zhCn.json`). `zhCn.json` holds the extracted Chinese source text; the other locales use the same message keys.

## Usage

Web settings and the first-run onboarding reuse `languageSelect.vue`: the settings page shows the language cards directly, and the onboarding opens the same set of cards from a button. Cards use local SVG flags and native language names, and support selection with the arrow keys and Home/End. On first run the language follows `navigator.languages`; a manual choice is saved in the existing `settings.ui.language` and does not overwrite the theme, models or other settings. After choosing "Follow system", the app keeps listening for system language changes. Chinese is resolved by script (Hans/Hant) first, then by region; unsupported system languages fall back to English.

Flag artwork comes from the ready-made 4:3 SVGs of [flag-icons 7.3.2](https://github.com/lipis/flag-icons/tree/7.3.2/flags/4x3). Only the root element is wrapped as a symbol in the local `languageFlags.svg`; the original paths, definitions, aspect ratio and MIT license notice are kept. Only countries actually referenced by the component are included, the full icon set is not installed, and nothing is requested from a CDN at runtime. When changing artwork, update it from the corresponding upstream resource instead of drawing it by hand. Flags are only a visual aid, and different languages may reuse the same icon.

Element Plus uses the complete language JSON files in `src/elementPlus/` (one per supported locale), wired into the global ConfigProvider through `@toonflow/i18n/elementPlus`; pagination, dates, upload, filters and accessibility hints update immediately with the language. Date formats and weekday names use the Day.js locales registered by Web. TDesign uses its built-in language packs, and the chat component text is supplied by the app dictionary.

Static Web text and explicit display attributes are transformed by `@toonflow/i18n/vite` before Vue compilation, so business source code keeps being written in Chinese. The transform only applies to `apps/web/src`; the compiler only handles known display positions, does not walk the DOM, does not call online translation, does not disable Vue static optimization, and does not remount pages to switch languages.

Dynamic text can use native JavaScript tagged templates, with no Babel macros needed:

```ts
import { t, msg, translate } from "@toonflow/i18n/vue";

// Show the current language at the time the action happens.
ElMessage.success(t`文件 ${fileName} 已保存`);

// Store a message descriptor and translate it when displayed; parameters are evaluated when the descriptor is created.
const saveLabel = msg`保存`;
const label = computed(() => translate(saveLabel));

// Dynamic parameters are evaluated inside a reactive scope.
const countLabel = computed(() => t`已选择 ${selectedCount.value} 个节点`);
```

`msg` keeps the template and parameters; `t` translates immediately. Translation functions from the Vue entry read the reactive language; a plain string obtained once during module initialization or in setup does not update automatically. Parameters are inserted as-is and are not parsed as a new template; curly braces and quotes are escaped by the tagged template. When plurals are needed, translations can use ICU MessageFormat `plural`; do not split a sentence into concatenated pieces.

The backend uses the request context in `apps/server/src/lib/i18n.ts`. `success/error` accept legacy Chinese strings as well as message descriptors; dynamic errors use that module's `t`. FFmpeg server errors can use `messageError` from `@toonflow/i18n/errors`, passing a descriptor created with the `msg` tagged template; it stores the source text and parameters and is translated at the system error exit. The backend must not call core's `setLocale` to switch the global language.

The language is resolved per request from `Accept-Language` (including q weights) and isolated per request; when no supported request language is present, the saved app language or the system language is used. Zod uses a language dispatcher that is registered once and reads the language per request. SSE, MCP and FFmpeg only handle recognized system errors; model output, successful tool results, unknown provider errors, user content and log details stay unchanged.

Providers, the tools and nodes subpackages, and the node scaffold are not internationalized and do not take part in text extraction. Plugin names and plugins' own text keep their original values; the plugin management menus, install actions and configuration validation messages in Web are still part of the app UI. No language runtime interface is provided between node builds and the host.

## Updating text

Run from the repository root:

```sh
bun run --cwd packages/i18n extract
```

This command only updates the Chinese source dictionary and `src/messageSources.json` (the message source index); it does not overwrite manual translations in other languages. Add the new keys to `en.json` and `zhTw.json`, keeping parameters such as `{0}`; when the Chinese source text changes, update the translations accordingly. When the same Chinese text needs different meanings, split it into separate messages explicitly; never decide business state from translated text.

The Element Plus JSON files are maintained separately from app text extraction. They are based on the complete set of 142 component strings in 2.14.5, and the upstream MIT license is kept in `src/elementPlus/license.txt`. When upgrading Element Plus, compare all keys and array structures against its English pack, then update every JSON file in `src/elementPlus/`. Component templates keep the original named parameters such as `{total}`, `{pager}` and `{column}` and do not use the app dictionary's ICU syntax; `name` must match a registered Day.js locale name. Type checking covers locale coverage and the structure relative to the local English pack, but it does not replace comparison with the upgraded upstream or proofreading of the translations.

When proofreading, follow the source index to the button events, state branches and actual API behavior, and confirm the target of the action, its scope and its completion condition. For example, a favorites category and "Add to favorites" have different meanings, and closing a dialog and "Don't use a highlight color" should also be translated separately; audio trim ranges, table rows, release notes and spending amounts must be understood in the context of their feature.

Display code that is not covered should call `translate/t` explicitly at the display boundary; do not widen the rules to every `message`, `label` or Chinese string. User data such as `data`, `inputs` and `outputs` is outside the scope of automatic translation. Existing logic that locates elements with `[aria-label="<Chinese text>"]` should switch to stable `data-*` identifiers.

Dictionaries are bundled with the app, and the runtime does not depend on a translation service. The translated dictionaries have been through an AI-assisted, entry-by-entry semantic review of the full set, with terms, negative conditions, action targets, numbers and template parameters re-checked; this is not equivalent to publication-grade review by native speakers of each language. Providers, the tools and nodes subpackages, third-party websites and the installer are outside the translation scope.
