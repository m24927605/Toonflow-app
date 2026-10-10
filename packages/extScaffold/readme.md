# Document Extension Scaffold

The document page uses Dockview to manage tabs, split views, and the close flow. Each workspace subpackage in `packages/ext/*` provides one file editor, previewer, or canvas node viewer. An extension only receives the `context` provided by the host and does not import `apps/web/src`.

## Creating an Extension

Run the following from the repository root:

```sh
bun packages/extScaffold/create.ts myEditor
bun install
bun run --cwd packages/ext/myEditor typecheck
bun run --cwd packages/ext/myEditor build
```

The argument is a lowerCamelCase name without `ext-`; for example, `myEditor` generates the ID `ext-myEditor` and the package name `@toonflow/ext-myeditor`. Creation is refused if a directory with the same name already exists. The command only creates directories and files; it does not implicitly install dependencies, build, or modify host configuration.

If writing fails midway, the files already created are kept. After fixing the cause, you can complete them or clean them up manually; the scaffold never rolls back by deleting directories recursively.

```text
packages/ext/myEditor/
  package.json
  tsconfig.json
  viteConfig.ts
  readme.md
  src/
    metadata.ts
    index.ts
    index.vue
```

The generated component can edit text directly and demonstrates icon and font size settings declared by the extension itself. Change the extension's display name, icon, file extensions, and configuration rules in `src/metadata.ts`, then implement the content of `src/index.vue`.

## Extension Declaration

```ts
// src/metadata.ts
import type { ExtDefinition } from "@toonflow/ext-scaffold/runtime";

export default {
  id: "ext-myEditor",
  displayName: "My Editor",
  extensions: ["txt"],
  resourceKind: "file",
  text: true,
  configRules: [{ type: "inputNumber", field: "fontSize", title: "Font size", value: 14, props: { min: 10, max: 32 } }],
} satisfies Omit<ExtDefinition, "load">;
```

The entry `src/index.ts` combines the declaration with the component loader:

```ts
import { defineExt } from "@toonflow/ext-scaffold/runtime";
import metadata from "./metadata";

export default defineExt({ ...metadata, load: () => import("./index.vue") });
```

`id` is unique across all extensions and has the format `ext-` plus a lowerCamelCase name, for example `ext-image` or `ext-canvasNode`; directories and variables still use lowerCamelCase. File extensions have no leading dot and use lowercase letters or digits. `resourceKind` is `file` or `canvasNode`; canvas node extensions may use an empty extension array. Text editors set `text: true` so that the host preloads the text and exposes document read/write capabilities; binary previews such as images omit this flag.

The optional `icon` is an image URL. It allows `http:`, `https:`, or `data:image` URLs for SVG, PNG, JPEG, WebP, GIF, or AVIF. The icon is declared with the extension output, and the host only displays it as an image; when none is declared, a generic file icon is used. Built-in extensions and the generated template use inline SVG, so no extra image request is needed.

The optional `configRules` reuses the existing form-create `Rule[]` used by the Plugins settings; each `rule.value` provides the default value, and no separate settings schema is created. Rules must be JSON-serializable, with at most 100 entries, and must not contain functions. When undeclared or an empty array, no settings entry is shown for the extension.

Fields in layout `children` and in conditional `control[].rule` are saved as well. Hidden, unsubmitted conditional fields do not trigger server-side required-field validation.

The host enumerates installed and enabled extensions from `data/ext/` and loads the UMD output and the component returned by `load()` on demand, without changing web workspace dependencies or a static registry. When several extensions are available for the same file extension, the host shows a "Choose How to Open" dialog where a default association can be set; the file tree's right-click "Open With…" lets you choose again. The scaffold never overwrites existing file associations automatically.

## Component Context

```ts
import type { ExtContext } from "@toonflow/ext-scaffold/runtime";

const props = defineProps<{ context: ExtContext }>();
```

| Field | Purpose |
| --- | --- |
| `resource` | Resource identity, including the workspace directory, relative path, and tab name; canvas nodes also include `nodeId`. |
| `files` | File capabilities pinned to the resource's workspace: `read`, `readText`, `readJson`, `write`, `writeJson`, `list`, `rename`, `copy`, `reveal`, `remove`, `mkdir`, `acquireUrl`. |
| `text`, `loading`, `error`, `dirty` | Text and load/save state managed by the host. Submit edits through `updateText()`; do not modify host state directly. `loading` also means editing is paused during file operations. |
| `active` | Whether the document page is active; canvas nodes mount or release their view based on it, and media components can pause on it. |
| `config` | The current extension configuration, including rule defaults and saved values; the host syncs it after the Plugins settings are updated. Do not modify it directly instead of saving. |
| `saveConfig(config)` | Saves the configuration declared by the current extension and updates host state; throws on failure. The Plugins settings use the same persistence entry. |
| `updateText(text)` | Updates the current tab's text; the host manages the save queue, so do not start a separate autosave. |
| `flushSave()` | Waits for the current tab's changes to finish saving; throws on failure. |
| `writeClipboardText(text)` | Copies text through the host's desktop or browser clipboard capability. |
| `openFile(path)` | Opens a relative path in the same workspace; the host manages file associations, node mapping, and tab deduplication. |
| `location` | An optional positioning request for the current view, containing 1-based `line` and `column`, a `query` to select, and a change marker `revision`. The extension watches it and positions its own editor; it is not part of the saved content. |
| `mountNode(element)` | Canvas nodes only. Renders the original node UI into the element and returns a function that releases the view; it must be called on unmount. |

Text saving supports UTF-8 (with or without BOM) and UTF-16 LE/BE with BOM, and preserves the original encoding. Unsupported encodings are refused on open, and the original file is not modified. Before saving, the host checks the file version recorded at read time; if an external change is detected, it stops overwriting and keeps the current edits so the user can choose to load the disk version or save a copy. Extensions should edit the current document through `context.updateText(text)` and must not call `context.files.write()` to bypass the host's encoding, save queue, and conflict protection.

The same file can be shown in several split views, and the content and save state share one session. Components should watch `context.text` to receive changes from other views; cursor, find, and edit mode stay within each component. Closing one view does not cancel saves in other views; a canvas node keeps a single running instance, and split views only move its view.

Binary previews obtain `{ url: Promise<string>, release() }` through `context.files.acquireUrl(path)`. Call `release()` when the resource changes or the component unmounts, whether or not loading has finished. Do not revoke the shared URL yourself. File operation failures must be surfaced in the UI, and paths must be relative paths within the current workspace.

`files.copy(path, target)` copies only within this workspace and refuses to overwrite an existing target. Directory copies disallow symbolic links; a failure may leave partial target content, which `partial` and `target` in the error data describe. `files.reveal(path)` is only supported in the desktop client or a local Windows/macOS development page; remote access is refused.

## Shared Markdown Editing Dependencies

Tiptap, marked, and DOMPurify reuse the host's dependencies through the build configuration's externals. Editors, preview components, toolbars, and lifecycles are implemented by each extension or node in its own package; they do not import host components, and there is no component forwarding layer. Subpackages that use these dependencies declare host-compatible peerDependencies: currently `3.31.3` for each Tiptap package, `18.0.13` for `marked`, and `3.4.16` for `dompurify`.

Use the dependencies' own APIs directly:

```ts
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";

const editor = new Editor({
  extensions: [StarterKit, Markdown],
  content: "# Title",
  contentType: "markdown",
});
```

Shared modules include `@tiptap/core`, `@tiptap/vue-3`, `@tiptap/starter-kit`, `@tiptap/markdown`, and `extension-find-and-replace`, `extension-highlight`, `extension-image`, `extension-list`, `extension-subscript`, `extension-superscript`, `extension-table`, `extension-text-align` (all with the `@tiptap/` prefix); also `@tiptap/pm/model`, `@tiptap/pm/state`, `@tiptap/pm/view`, `marked`, and `dompurify`. The build output references the corresponding dependencies in `window.toonflowTiptapHost` instead of bundling these implementations again.

Tiptap always uses named imports, for example `{ StarterKit }`, `{ Image }`, `{ Highlight }`, `{ Superscript }`, `{ Subscript }`, `{ TextAlign }`, `{ FindAndReplace }`. With the current Vite 8 UMD build, a default import takes the entire external module object, so it cannot be used for these shared modules. DOMPurify shares its default function separately, so keep using `import DOMPurify from "dompurify"`. There is no need to enable the legacy CJS compatibility switch that affects all dependencies.

The host first checks whether the UMD references `toonflowTiptapHost` and dynamically loads the shared dependencies only when needed, then reuses the same ES module; ordinary image, video, or plain-text plugins do not preload Tiptap because of this. Each package still manages component mounting, destruction, hidden state, content updates, and file saving. Output that uses the shared dependencies requires a matching host version.

## Standalone Build and Development

`viteConfig.ts` uses the shared configuration:

```ts
import { createExtConfig } from "@toonflow/ext-scaffold";
import metadata from "./src/metadata.ts";

export default createExtConfig(metadata, import.meta.url);
```

The declaration file does not import components, so the configuration bundler does not resolve Vue files early. Each rebuild rereads the declaration and its dependencies, so changes to file extensions, icons, and settings flow into the UMD metadata; restart the build after changing the extension ID.

The output is `build/ext/<id>.umd.js`, for example `build/ext/ext-image.umd.js`, and contains a `toonflowExt` JSON metadata comment, the version, the readme, and automatically injected component styles. The output exports `window.toonflowExts[id]` with the `ExtDefinition` shape. Vue, Element Plus, and the Toonflow language state are shared by the host:

```ts
import * as vue from "vue";
import * as elementPlus from "element-plus";
import * as i18n from "@toonflow/i18n/vue";

Object.assign(window, { toonflowExtHost: { vue, elementPlus, i18n } });
```

Runtime code uses `@toonflow/ext-scaffold/runtime`; the build configuration uses `@toonflow/ext-scaffold`, which keeps Vite and file system code out of the browser bundle. Element Plus base styles are loaded by the host, and the extension's own component styles are bundled into the output.

`bun run --cwd packages/ext/myEditor dev` builds continuously and atomically replaces the output in `data/ext/` for the local Plugins settings and the document host to read. One-off builds with `NODE_ENV=dev` or `--mode development` sync as well; production builds only output to `build/ext/`.

The plugin metadata contains `id`, `displayName`, optional `icon`, `configRules`, `extensions`, `resourceKind`, optional `text`, `version`, and `readme`. `load` stays in the runtime export and is not written to the JSON metadata. Settings → Plugins handles installation, updates, and enabling/disabling; the scaffold handles declaration, generation, and standalone builds.
