# Internationalization Regression Record

> Note: the locale set was later reduced to English (`en`), Traditional Chinese (`zh-TW`) and Simplified Chinese (`zh-CN`). The records below describe the state at the time of each round.

Date: 2026-09-30. Verification repository: `F:/aa/toonflow2`.

This round added Traditional Chinese, English, Japanese, Russian, Vietnamese, Thai, Korean and Hindi, for nine languages together with the existing Simplified Chinese. The installer was not changed. All configuration and API write verification used a temporary data directory; no real user configuration was modified and no paid generation was run.

Following a later scope adjustment, the i18n integration of providers, tools, nodes and the node scaffold was reverted, together with the node-specific FFmpeg browser integration. System text for Web, the server, the desktop app and the MCP/FFmpeg server-side base capabilities was kept.

The initial phase extracted 2022 source strings, with 16176 translations across the eight new languages; the key sets of the eight dictionaries matched with no empty values, and 1600 dynamic ICU translations passed format validation. Excluded subpackages have zero entries in the message source index, and calling the Vite plugin directly does not transform those paths either. The three rounds below keep the verification results that are still within the current scope; the latest data for the added Asian languages is at the end.

## Round 1: Language basics and request chain

- Verified locale normalization, system language priority, Hans/Hant, and fallback to English for unknown languages; a manual choice takes precedence over the system language, and choosing "follow system" again resumes listening.
- In the real first-run onboarding, switched through the eight new languages one by one, checking the page language, the `Accept-Language` of save requests and the selection after refresh; theme, privacy and onboarding completion state were unaffected.
- Checked template parameters, curly braces, single quotes, literal HTML text and unknown-message fallback; parameters are inserted only once.
- Sent 36 concurrent HTTP requests in nine languages to the real server, checking responses, request context and `Content-Language`.

## Round 2: Persistence and real interaction

- Switched languages on the hello page of a production build; the current setup step stayed unchanged.
- Switched the settings dialog to Traditional Chinese, Russian, Hindi and Thai, confirming that the input stayed the same DOM node, the dialog did not close, and drafts containing Chinese, template symbols and characters from several scripts were preserved as-is.
- Saved and read settings, checking that other fields were preserved. With a simulated Japanese system environment in which the settings request failed, the startup failure page and retry button used Japanese, and unknown network errors kept their original text.
- Made concurrent calls from independent MCP SDK sessions, confirming that system errors are returned in the request language and successful tool results stay unchanged.

## Round 3: Layout and full build

- At 360px width, checked the onboarding in English, Russian, Vietnamese, Thai, Korean and Hindi: no horizontal page overflow, long buttons wrap, and the language dropdown works with the keyboard.
- The settings menu updates instantly between Japanese, Russian, Hindi and English; onboarding screenshots in all nine languages passed.
- Switched the Agent input repeatedly between English, Japanese, Russian and Hindi; the editor stayed the same DOM instance and the draft was fully preserved.
- The repository-wide type check, the Web/server/tool production builds and seven node builds passed. The build still shows the existing large-chunk and Electrobun config extension warnings, which do not block completion.

Commands actually run:

```sh
bun run --cwd packages/i18n extract
bun run typecheck
bun run build
bun run build:nodes
bun run --cwd apps/server routes
git -c core.safecrlf=false diff --check
```

Following the repository rules, no test files or test frameworks were added; extra assertions ran as inline scripts in temporary processes.

## Independent adversarial checks after the three rounds

- Compile-time transform: Chinese comparison values, object keys, indexes, protocol enums, user file names, prompts and persisted node names keep their original values; `toRaw` and JSON serialization are unaffected by display getters.
- Template boundaries: `v-pre`, `pre`, `translate="no"`, ignore markers, attribute values containing a greater-than sign, camelCase display attributes, and the label/value semantics of legacy radios.
- Reactivity: switching languages does not remount pages, reset onboarding steps or clear inputs; menus, placeholders, accessible names and Markdown controls update.
- HTTP: 12 kinds of malformed or weighted language headers, 9 real field validations, 32 concurrent direct Zod validations, and over-long system prompt validation in 9 languages; fixed the acceptance of malformed q values and the missed extraction of explicit entries under the prompt attribute.
- MCP/FFmpeg: 9 MCP SDK sessions and 18 tool calls; FFmpeg server-side structured errors in 9 languages.
- Parameter boundaries: 7 kinds of malicious or special interpolation times 9 languages, 63 groups in total; 5 kinds of invalid descriptor parameters; prototype property names are not treated as dictionary translations.
- Model boundaries: SSE on the real generation route used a local LLM fetch mock; output text, system prompts, user input and the `done.message` object structure stayed unchanged; unknown provider errors kept their original text.
- Dictionary review: fixed empty values, punctuation-only values, entries mixed together by batch translation, brand mistranslations and technical-field mistranslations; re-translated the affected and adjacent entries sentence by sentence, and verified source key sets, parameters, abnormal line breaks and fidelity of technical fields.
- Gaps found in real screenshots: fixed the missing translation of the camelCase `emptyText` in the directory picker, the accessible name of the Agent input, and internal horizontal scrolling caused by long words in the Russian settings sidebar.
- Browser re-check: the Russian settings sidebar and all menus have no internal horizontal overflow; onboarding screenshots in nine languages passed, and the primary button wraps automatically in Russian at 360px.
- Every issue found was fixed within its scope and re-verified; a successful build does not replace the browser, API and persistence checks above.

## Additional verification after the scope adjustment

- Precisely reverted the subpackage changes; `packages/providers`, `packages/tools`, `packages/nodes` and `packages/nodeScaffold` have no content diff relative to HEAD.
- Removed the Web translations of plugin names and the node-specific language runtime exports, and removed the `tool.error` interface from the provider host; kept the app-level management and configuration messages.
- Re-extracted and trimmed the eight dictionaries, removing 381 entries used only by the excluded scope; re-ran the type checks, artifact checks and builds instead of reusing the node translation verification results from before the revert.
- The repository-wide type check, the Web/server builds and 7 node and 8 tool builds all passed; the artifacts contain no node-host language interface or language dictionaries, and the Chinese plugin text is retained. The new transform-boundary assertions and the 1600 ICU validations passed.

## Additional regression for the language card UI

- The settings page shows the cards inline, and hello shows the same `languageSelect.vue` in a popover; all nine languages use local SVG flags and native language names.
- Switched through the nine languages in both entry points; the selected state and the UI update instantly. Hello closes the popover after a selection, while the settings page keeps the current dialog open. Follow system, refresh after saving and preservation of other settings passed.
- Checked Home/End, the arrow keys, Esc and clicking outside to close; on the settings page, Esc keeps its existing behavior of closing the settings dialog.
- With a 360px narrow screen, dark mode and 125% font size combined, the settings language cards automatically use two columns, with no internal or page-level horizontal overflow.
- Independent review found that the popover lacked an accessible name, and that in a short 1024×400 window focusing a card did not scroll it into view. Added the translated name, and made focusing scroll only the language popover so the hello page does not scroll along with it. After the fix, reopening with Hindi selected and switching with Home/End kept the cards visible and the page scroll position stayed at 0; the popover name in the accessibility tree correctly showed "Language".
- The Web type check, production build and diff check passed; verification kept using an independent temporary configuration and service, without modifying the dev service the user was running.

## Verification scope and limitations

- The translations were machine-assisted, with revision of common terms and structural validation; they have not yet been reviewed entry by entry by native speakers of each language.
- A real browser covered Web; native desktop dialogs went through type checking and error-path checks, and no real-device verification of native Windows/macOS windows is claimed.
- The FFmpeg checks covered local errors, serialization and language propagation, without actually downloading and installing FFmpeg.
- Third-party websites, user content, user-defined plugins and unknown provider errors keep their original text. Some languages that the bundled TDesign does not provide use the English base, and the text of the chat component in use is supplied by this project's dictionary.
- During browser configuration verification, one invalid test API key triggered a TF-Router model list request that returned 401; no real credentials were used, the key was not saved and no model generation was called. Verification of the backend generation path used mocks. The initial translation and sentence-by-sentence corrections used a translation service; the app runtime does not depend on it.

## Asian language expansion: three additional regression rounds

Added `id/ms/fil/bn/ur/ta/te/mr/pa/ar/fa/tr`, for 21 languages in total. Each dictionary contains 2022 source keys, for 40440 entries across the twenty translations; this round added 24264 translations. Punjabi uses the Gurmukhi script, and Arabic, Persian and Urdu support RTL. The installer and the excluded subpackages were not extended.

1. Dictionaries and build: re-extraction still yields 2022 entries; the full key, duplicate key, empty value and generation marker checks passed, 4000 dynamic ICU format and parameter groups matched, and 147 special interpolation groups were not parsed twice. The repository-wide type check and the Web/Server/MCP production builds passed. The validation script used numeric parameters for ICU plural messages, to avoid treating arbitrary strings as valid plural input.
2. Real interaction: an independent service at `127.0.0.1:3118` with a dedicated temporary configuration; switched hello through the 12 new languages one by one, with no Chinese fallback in the content and no horizontal overflow on desktop. Refresh kept Turkish, and follow system restored Simplified Chinese. After switching in settings the dialog stayed open, and creative drafts containing Chinese, Arabic, Tamil and template symbols were preserved as-is. Popover End/Home/Esc, scrolling to the end and focus restoration passed, and the page did not scroll along.
3. Narrow screens and APIs: at 360×780, 125% font size and dark mode, switched through the 12 new languages in settings one by one; page width and scroll width were all 360 and the content area 252; the hello popover holds 22 options (including follow system) and scrolls internally. Fixed an overflow on the RTL home page caused by the Star hint using physical `right` positioning; the Persian re-test passed. The real MCP address input stays LTR. 63 concurrent real HTTP requests across the 21 languages returned the correct response language, parameter errors, dynamic limit hints and Content-Language; settings were identical before and after invalid requests; after the final dictionaries were reloaded, the same request set passed again.

The wording review additionally revised 589 common words and key long sentences, reviewed item by item the 12-language translations of 54 boundary source entries, and checked the negation semantics of non-empty and delete/save/retry. Fixed errors such as "no more than" being inverted, mistranslations of non-empty, the meaning of recursive delete, canvas being translated as fabric, naming formats and file extensions. Structural validation and focused revision do not mean that all translations have been reviewed sentence by sentence by native speakers.

This round added no test files, dependencies or default automatic check entries, and did not modify real user configuration or call model generation. Where some component library language packs are missing, English is still used as the fallback within the scope listed in the readme; some existing physical-side styles, such as document decorations, are not fully mirrored.

The independent adversarial check after the three rounds passed: 55 normalization groups, 4 language detection groups, 9 request header groups, 630 isolation assertions across 126 concurrent contexts, 63 interpolation/prototype property groups and 2101 cache rotations. The source asset and the build artifact both contain 15 SVG symbols, with no disabled flags; providers, tools, nodes, the node scaffold, the installer and the file package are unchanged. The adversarial spot check additionally fixed "cache hit" being mistranslated as a physical strike in five languages, plus four directory case conflicts and one identifier description across twelve languages (60 entries), keeping the parameters and the ID/case restrictions. In total, 654 key entries were revised, and the full dictionary checks and the Web/Server/MCP builds passed again.

Flag correction addendum: following user feedback, Arabic and Persian switched to the flags of Saudi Arabia and Iran respectively; the orientation of the Turkish star and the details of the Philippine sun and stars were also corrected. The four designs are taken from individual flag-icons 7.3.2 SVGs, with the license kept in the local sprite and without adding the whole dependency. Removed the unused globe placeholder symbol, leaving 16 symbols. A production browser confirmed the mapping of the 21 languages and the correct rendering of the four designs; the five Indian languages continue to share the India icon. The Web build and XML/diff checks passed.

Unified artwork source addendum: the remaining twelve hand-drawn designs were also replaced with flag-icons 7.3.2, so all sixteen are now the original upstream SVG artwork. Independently re-checked that each symbol's internal nodes, attributes, order and viewBox match the original file; the 31 IDs have no duplicates, all 20 internal references are valid, and there are no external references. The mapping of all 21 languages is complete and no previously disabled flags are included; the xlink namespace and the full MIT license were kept. A card-by-card reference check and a screenshot check of the whole artwork set in a production browser passed with no console errors; the Web build and diff check passed.

## Full text and README proofreading (2026-10-01)

This round read through the Simplified Chinese source text and all 20 translated dictionaries entry by entry: 2022 entries each, 40440 translations in total. It also proofread the full text of the 45 source READMEs in the repository, excluding copies in dependencies, build artifacts and runtime data. The project home page only introduces multilingual support and the list of languages, and all 21 home pages keep the full language navigation.

There were 4691 semantic, terminology and formatting revisions in total, de-duplicated by source entry within each language; the uniform source key spelling replacements are counted separately:

| Language | Revised translations |
| --- | ---: |
| Traditional Chinese | 24 |
| English | 337 |
| Japanese | 193 |
| Russian | 229 |
| Vietnamese | 282 |
| Thai | 258 |
| Korean | 206 |
| Hindi | 176 |
| Indonesian | 261 |
| Malay | 272 |
| Filipino | 279 |
| Bengali | 177 |
| Urdu | 275 |
| Tamil | 214 |
| Telugu | 188 |
| Marathi | 196 |
| Punjabi | 319 |
| Arabic | 263 |
| Persian | 286 |
| Turkish | 256 |

Corrections included text-to-image/video mistranslated as a person's name, ungroup mistranslated as deserialize, voice timbre mistranslated as wood, abort mistranslated as a medical procedure, and terms such as resolution, items per page, undo and grid snapping. In long sentences, the main fixes were missing negation, confusing reading with modifying, confusing deleting a message with deleting a conversation, cancel state, file size limits, username and password restrictions, local-only operation restrictions, the authorizing party, and the conditions for preserving user modifications.

Documentation fixes included the APIMart sponsorship scope having "compute" added without authorization, the historical letter omitting the result "still could not understand it after a long time", some untranslated navigation, and, in the node scaffold, an outdated note on asset deletion, an existing node directory used as the example for creating a new one, and the name of the tool installation entry. For nodes and tools only the existing READMEs were corrected; no i18n integration was added for their business text. In the Chinese source, `asstes` was changed to `assets` and "从剪切板粘贴" to "从剪贴板粘贴" (a spelling fix for "paste from clipboard"); all dictionary keys were synchronized and re-extracted, still 2022 entries.

Three regression rounds:

1. Dictionaries and sources: the key sets, order, duplicate keys, empty values, leading/trailing newlines and encoding of the 42462 entries across 21 dictionaries passed; the source index matches the Chinese source and the excluded subpackages are not included. The ICU parameter ASTs of 4200 dynamic messages matched, 16800 numeric formatting runs and 38262 static translations passed, and 1659 technical identifier checks passed. In the number spot checks, the dot thousands separator in Indonesian and Turkish is normal local formatting.
2. Runtime boundaries: 29393 interpolations containing Chinese, Arabic, Punjabi, curly braces, single quotes, newlines, HTML literals and emoji were preserved as-is; 84 unknown-content and prototype-property-name cases, 126 concurrent language contexts and the language normalization/fallback checks passed. The real translation and error exit functions were used, and no external model requests were run.
3. Documentation and build: the 1209 local links in the 45 READMEs and their path casing all passed; the 21 project READMEs had all 420 language navigation links, the condensed language support section, 10 main sections, 5 installation subsections, 8 code blocks, 5 details blocks and 10 screenshots. Apart from translatable shell comments, the installation and operations commands are identical to the Chinese version. The i18n/Web/Server/MCP type checks and the Web/Server/MCP production builds passed. The build still has the existing large-chunk and Electrobun config extension warnings.

The independent adversarial semantic spot check covered 750 entries, and issues with the same source were traced back into the other languages. The final round patched 26 translated values concerning the authorizing party, the order in which `expectedText` is read and sent back, identical `name` values, asset references, and the delegation target of the built-in Agent; the on-disk results were checked item by item, and the full dictionary, interpolation and concurrency checks and the production build passed again. The final diff check passed.

This round added no test files, test frameworks or dependencies, did not modify real user configuration, and did not stage or commit. No new browser interaction or desktop real-device tests were run; the related records above belong to earlier rounds. A full AI-assisted semantic review plus structural and runtime verification is not equivalent to entry-by-entry, publication-grade review by native speakers of each language, and does not guarantee that all wording is 100% correct.

## Review by actual feature scenario (2026-10-01)

After the previous round's full dictionary review, real button events, state branches and API implementations were traced through `messageSources.json`, and the corresponding translations were reviewed again. This covered workspace and project management, canvas and node operations, saving and moving assets, document editing, Agent messages and tasks, memory and A2A/MCP, model and plugin management, UI settings, payments and app updates; the feature promises in the README were also checked against the implementation. This round was a scenario-focused review, and entries that were not re-checked one by one are not claimed as newly human-verified.

Revised 232 existing translated values; added 11 new source entries and replaced 1 recharge prompt, involving 240 new translated values. Each language now has 2033 entries, 42693 across the 21 dictionaries. The key fixes distinguish grouping as an entity from grouping as an action, the save-location field from the save action, documents from product documentation, table rows from text lines, and cover numbered lists, audio time ranges, release notes, the cumulative spending amount, closing the session panel, the confirmation for canceling a remote task, and the read/write ban after memory is turned off. The favorites filter keeps the noun, while "Add to favorites" uses a separate action entry; "Off" for edge color became "Don't use a highlight color"; the recharge prompt now states explicitly that it closes the current recharge dialog.

Display outlets not covered by the automatic transform were also fixed: six provider debugging states, cache import and save prompts, the default build identifier prompt, document heading levels, memory edit conflicts, the truncation note in mention previews, and canceling canvas operations. Internal state values and comparisons are unchanged, and the preview text and system notes are handled separately; user text, provider responses, localStorage keys and values, and unknown errors remain as-is.

Three regression rounds:

1. Dictionaries and sources: re-extracted 2033 entries; key sets, order, non-empty values, encoding, ICU parameters and source scope are consistent across the 21 languages; 4221 dynamic messages, 16884 numeric formatting runs, 38472 static translations and 1659 technical identifiers passed.
2. Real display and boundaries: the 9 modified components went through the real transform and Vue script/template compilation; 147 debugging states, 84 document heading/body scenarios, and 63 user content and error boundary assertions passed. With the same state and message descriptor held fixed, switching languages updates immediately. Import and batch delete passed in 294 numeric scenarios at 0, 1, 2, 3, 11, 21 and 101; in all 21 languages the favorites noun and the add action are displayed separately. 29491 special interpolations, 126 concurrent language contexts, 84 unknown-content/prototype-property cases and 7 language boundary cases passed. Real audio processing kept the 4000 original samples between 0.25 and 0.75 seconds of a 2-second input, and four error branches were verified.
3. Documentation and build: the 1209 local links in the 45 READMEs and the navigation/structure/command checks of the 21 project home pages passed; the i18n/Web/Server/MCP type checks and the Web/Server/MCP production builds passed. The build only keeps the existing large-chunk and Electrobun config extension warnings.

The independent adversarial review corrected 8 entries in 4 languages that confused audio "range" with "time limit", and added singular/plural forms for import counts in 5 languages; Arabic and Urdu use count labels to avoid numeral agreement issues. It also confirmed that "tool call returned" is not rendered as the subtask being completed, and that stopping local debugging was not translated as a confirmed cancellation of the remote task.

The final adversarial pass found that the screen reader name of the favorites button still contained Chinese: when a template's static segment contained no Chinese, the transformer returned early and missed the conditional text inside. The recursion over the existing display expression was fixed without adding an automatic transform entry; comparing the 106 Web source files before and after the fix, only that display expression of the favorites button changed, and the total message count is still 2033. 42 language/favorites state name checks, 6 independently executed real screen-reader expressions, and boundaries such as pure user templates, nested conditions, storage keys and values, and not double-wrapping existing translations passed; business state and plugin names were preserved. Finally, "Unfavorite" was corrected in 3 languages to mean removing from favorites, and the type checks and the Web/Server/MCP builds passed again.

This round added no test files, dependencies or frameworks, did not modify real user configuration, and made no real model requests, staging or commits. This round did not launch a browser or a native desktop window, so the component compilation and reactivity checks must not be described as real-device browser interaction tests.

## Complete Element Plus language packs (2026-10-01)

Based on Element Plus 2.14.5, 21 complete JSON files are stored in `src/elementPlus/`, each with 142 component strings, keeping the upstream MIT license. `@toonflow/i18n/elementPlus` exports them in one place, and the App's ConfigProvider responds directly to the selected language; the English fallback for `fil/ur/mr/pa` and scattered close-button patches were removed. Web declares and reuses Day.js 1.11.23, which was already in the lockfile, and registers the corresponding date locales; `fil` uses `tl-ph` and Gurmukhi `pa` uses `pa-in`. The missing-language strategies for TDesign and Zod were not part of this round.

Besides filling in remaining English text, fixes included the official Korean increase/decrease direction being reversed, Malay translating the `{color}` / `{max}` parameters and two invalid keys, the wrong meaning of the Tamil clear button, the wrong meaning of the Telugu date keyboard hint, the Indonesian delete-key hint, and the wrong meanings of closing a dialog and resetting filters in Arabic. Color alpha was translated by its actual numeric direction, with 0 transparent and 100 opaque; table rows, quarters, the carousel and the captcha were proofread according to the component's operation semantics.

Three regression rounds:

1. Full JSON and the real translation function: the keys, order, types and array structures of the 2982 component strings across the 21 files match the English pack of the installed version, and the 504 named parameters match. Element Plus's own `buildLocaleContext` / `buildTranslator` were used to check consecutive language switches and the verbatim insertion of parameters containing curly braces, quotes, HTML literals and emoji. Name, month and weekday formatting passed for the 21 Day.js locales, and importing them does not change the global default locale.
2. Real browser components: an isolated preview page generated in memory loaded the repository language packs and the real Element Plus components, and switched through all 21 languages consecutively. Pagination, empty states, number input hints and calendar titles match the JSON, and input drafts and their DOM identifiers stayed unchanged; a real `ElMessageBox.confirm` was opened and canceled in each language with the correct confirm and cancel text; the date popover was opened in each language, and the 7 weekday headers and keyboard screen-reader hints were all localized. The Korean increase/decrease buttons were also actually clicked, with values going 5 → 6 → 5; after selecting a date in Punjabi the value was `2026-10-13` and the draft was not lost. The isolated page made no app API calls, configuration writes or external generation requests.
3. Integration and build: the i18n and Web type checks, the Web production build and the diff check passed. The build keeps the existing large-chunk and Electrobun config extension warnings; the isolated dev page shows a Vue compile-time feature flag hint, with no component runtime errors.

After the checks above, all keys and parameters, untranslated English sentences and writing systems were re-checked independently; legitimate identical words such as OK, some month abbreviations and the Indonesian "Total" are not falsely flagged as untranslated just because they look the same. The configuration chains of the real ConfigProvider's normal subtree, Teleport subtree and programmatic components detached from the parent tree passed 189 assertions, verifying the global configuration hook used by the programmatic MessageBox; the full dialog DOM behavior is additionally covered by the second-round browser verification.

This round added no test files or test frameworks, did not modify real user configuration, and made no paid requests, staging or commits. The browser verification covered an isolated page of real components and is not claimed as a regression of full business pages or native desktop windows.

The isolated verification also confirmed an upstream limitation of Element Plus 2.14.5: the date panel caches the first day of the week when it is created, so switching languages updates the weekday text, but the column order keeps the instance's initial value. Web currently does not use date or calendar controls, and the dynamic form entry does not register these two component types either, so this round neither modified dependencies nor remounted the global page. If such controls are added later and the first day of the week needs to change immediately, verify an upstream fix, or rebuild only the specific date control while keeping its bound value.
