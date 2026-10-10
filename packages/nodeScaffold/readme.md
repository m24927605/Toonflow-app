# Node Scaffold

`@toonflow/nodes-scaffold` provides the shared Vite configuration, the node skeleton, and host interfaces. Each node plugin in `packages/nodes/*` maintains its own dependencies, Vue child components, and build entry. Source shared across plugins lives in `packages/nodeShared` as the standalone package `@toonflow/node-shared`, which is not built as a node on its own.

```text
packages/nodeScaffold/
  index.ts                 Shared build configuration
  src/runtime.ts           Single entry for browser components, composables, types, and utilities
  src/useNode.ts           Current node state, ports, outputs, events, and file capabilities
  src/nodeSkeleton.vue     Shared title bar, content Card, and left/right connection points
  src/values.ts            Fixed output structures and type validation
  src/nodeInputs.ts        Reads upstream values by target node and input port
  src/nodeEvent.ts         Registers node input, output, delete, and connection-validation events in one place
  src/workspaceFiles.ts    Uses host file capabilities and uploads node files
packages/nodeShared/       Components and business logic shared across plugins; standalone package @toonflow/node-shared
packages/nodes/imageNode/
  package.json             This node's own dependencies
  vite.config.ts           References the shared configuration
  tsconfig.json
  src/index.vue            This node's only entry
build/nodes/
  imageNode.umd.js          Metadata, component, child components, dependencies, and styles of a single node
data/nodes/
  imageNode.umd.js          Synced during development for the server to load
```

Put child components in the node's own `src/components/` and utility functions in other directories, then import them normally; they do not produce separate node entries.

`packages/nodeScaffold` only provides generic node foundations, build configuration, and host interfaces; runtime capabilities are imported from `@toonflow/nodes-scaffold/runtime`. Plugin-specific components, interactions, prompts, presets, and business logic stay in the owning plugin and are reused through its public exports. Components and business logic shared across plugins live in `packages/nodeShared` and are imported through the public subpaths of the standalone package `@toonflow/node-shared`; they are never mixed into the scaffold. The root entry `@toonflow/nodes-scaffold` is only for importing `createNodeConfig` in Vite configs; do not reference it from browser components.

## Shared Markdown editing dependencies

Tiptap, marked, and DOMPurify reuse the host's dependencies through `external` in the build configuration. Editors, preview components, toolbars, and lifecycles are implemented by each extension or node in its own package; they do not import host components, and there is no component forwarding layer. Subpackages that use these dependencies declare host-compatible peerDependencies: currently `3.31.3` for all Tiptap packages, `18.0.13` for `marked`, and `3.4.16` for `dompurify`.

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

The shared modules are `@tiptap/core`, `@tiptap/vue-3`, `@tiptap/starter-kit`, `@tiptap/markdown`, and `extension-find-and-replace`, `extension-highlight`, `extension-image`, `extension-list`, `extension-subscript`, `extension-superscript`, `extension-table`, `extension-text-align` (all with the `@tiptap/` prefix), plus `@tiptap/pm/model`, `@tiptap/pm/state`, `@tiptap/pm/view`, `marked`, and `dompurify`. Build output references the corresponding dependencies in `window.toonflowTiptapHost` and does not bundle these implementations again.

Always use named imports for Tiptap, for example `{ StarterKit }`, `{ Image }`, `{ Highlight }`, `{ Superscript }`, `{ Subscript }`, `{ TextAlign }`, `{ FindAndReplace }`. With the current Vite 8 UMD output, a default import resolves to the whole external module object, so it cannot be used for these shared modules. DOMPurify shares its default function separately, so keep using `import DOMPurify from "dompurify"`. There is no need to enable the legacy CJS interop switch, which affects every dependency.

The host first checks whether a UMD references `toonflowTiptapHost` and loads the shared dependencies dynamically only when needed, reusing the same ES module afterward; plain image, video, or text plugins therefore do not preload Tiptap. Mounting, teardown, hidden state, content updates, and file saving are still managed by each package. Output that uses the shared dependencies requires a matching host version.

## Plugin-side business reuse

Prompt input, reference lists, generation history, generation status, and error explanations live in `packages/nodeShared`. Consuming nodes declare a `@toonflow/node-shared` workspace dependency and import by subpath:

```ts
import promptInput from "@toonflow/node-shared/promptInput";
import referenceItem from "@toonflow/node-shared/referenceItem";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";

const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences("in");
```

Image editing, grid splitting, inpainting, and relighting are imported from the corresponding subpaths of `@toonflow/node-image`; the video player is imported from `@toonflow/node-video/videoPlayer`. Shared source is bundled with the consuming node, while Vue, VueFlow, and Element Plus keep reusing the host instances.

## Node skeleton

Import `nodeSkeleton` and `useNode` from `@toonflow/nodes-scaffold/runtime`, and wrap the content of the node entry in `<nodeSkeleton v-bind="nodeProps">`. `label` defaults to `未命名节点` ("Untitled node"). The title bar on top has no border, the content below uses an Element Plus Card, and the default slot holds the node content. Keep `defineOptions({ inheritAttrs: false })` in the node entry so that top-level attributes passed by VueFlow do not override skeleton props such as `label`.

A 16px icon appears to the left of the title, `IconBox` by default. The node entry declares its icon in `defineOptions({ icon: IconPhoto })`, and `useNode()` and the canvas node list reuse the same component. A single instance can still override it through `useNode({ icon })` or the skeleton's `:icon`; the icon does not need to be written to the node's `data`.

Connection points are defined by the `handles` array; there are none by default. Each item contains an `id` that is unique and stable within the node, a `type` (`target` is an input on the left, `source` an output on the right), a data type `dataType`, and an optional hint `label`. One side can have several connection points, spaced evenly in array order; a single point is centered. The Card grows taller with the number of connection points.

Each node declares its default ports in `defineOptions({ handles })`, and the UMD component exposes this array directly so the canvas can filter the list of connectable nodes before creating one. `useNode()` copies this definition into a separate `handles` ref automatically; dynamic initialization can still override it with `useNode({ handles })`, and definitions or defaults are never read from `data.handles`. Nodes control the number, types, hints, and order of their ports by modifying `handles.value`; acceptance rules are registered via `nodeEvent.on("canConnect", callback)`. `nodeProps` follows title changes on the canvas automatically. Edge anchors are re-measured after the title wraps or port positions change; removing a port, or changing a port's ID or input/output direction, cleans up the edges left dangling on the original port.

```vue
<template>
  <nodeSkeleton v-bind="nodeProps">
    <el-input v-model="outputs.text.value" type="textarea" class="nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop />
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { ElInput } from "element-plus";
import { nodeSkeleton, useNode, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";

defineOptions({
  inheritAttrs: false,
  handles: [{ id: "text", type: "source", dataType: "STRING", label: "Text output" }] satisfies NodeHandle[],
});
const { nodeProps, outputs } = useNode({
  label: "Text",
  outputs: { text: { dataType: "STRING", value: "" } },
});
</script>
```

`useNode(options?)` accepts `label`, `icon`, `handles`, and `outputs`, and returns `id`, `node`, `config`, `nodeProps`, `handles`, `outputs`, `nodeEvent`, `nodeTools`, `files`, `ai`, `ffmpeg`, and `updateNodeInternals`. `nodeProps` is a computed for binding to the skeleton that contains the title, icon, ports, and outputs. `outputs` infers its types from the defaults and restores the valid outputs saved for the current node, accepting only source ports that still exist and have matching types. Text defaults stay `STRING`; an image node with no saved output stays empty.

`files.uploadFile(file)`, `files.removeNodeFiles()`, and `updateNodeInternals()` are already bound to the current node, so no ID needs to be passed; `files` also provides `getWorkspaceFiles()` and `useFileUrl()`. Port definitions, the specific UI, upload validation, and mutual exclusion between upload and delete remain the business node's responsibility. Selection state can use `node.selected` directly, for example by binding `v-model:bottomVisible="node.selected"`.

`useNode()` also returns `previewReady` and passes it to the skeleton through `nodeProps`: the default slot is mounted only when the node first comes near the viewport, after which the preview and UI state are kept. Tool registration, outputs, and generation tasks belong in the node's own `setup` and must not depend on the preview child component being mounted; to mount content immediately, set `:previewReady="true"` on the skeleton explicitly. During box selection or dragging, the top and bottom slots are not mounted; they return after a single node is clicked.

Unconnected connection points use `IconCircleDashed`, connected ones use `IconCircleDot`, and the dashed circle returns after the last edge is removed. The icons are 18px with a transparent pointer hit area extending 8px outward (34px in total); the former solid circle background is no longer shown.



### FFmpeg media processing

`await useNode().ffmpeg(signal?)` returns a factory bound to the current workspace; obtain `ffmpeg` in the component setup and call it from event handlers. You can also use `useNodeFfmpeg()` on its own (imported from runtime or `@toonflow/nodes-scaffold/nodeFfmpeg`). The calling style matches the fluent chain used by tools and supports multiple inputs and outputs, complex filters, screenshots, concatenation, `clone()`, `ffprobe`, and capability queries such as available encoders.

```ts
const { ffmpeg: loadFfmpeg, id } = useNode();

async function compose(signal?: AbortSignal) {
  const ffmpeg = await loadFfmpeg(signal);
  // Create the output directory beforehand through files; use a new file name so the source asset is not overwritten.
  const output = `assets/${id}/combined.mp4`;
  await new Promise<void>((resolve, reject) => {
    ffmpeg("assets/first.mp4")
      .input("assets/second.mp4")
      .complexFilter("[0:v][1:v]hstack=inputs=2[video]")
      .outputOptions("-map [video]")
      .videoCodec("libx264")
      .on("progress", progress => console.log(progress.timemark))
      .on("error", reject)
      .on("end", () => resolve())
      .save(output);
  });
  return output;
}
```

Chained calls are handed to the host's `@toonflow/ffmpeg` through `/api/ffmpeg/execute`; the node UMD does not include the Node.js execution library. The `start`, `progress`, `stderr`, `codecData`, `filenames`, `end`, and `error` events are supported, along with `on/once/off`. Configuration is completed before execution; run things in parallel with separate commands or `clone()`. The directory is fixed when the factory is obtained, so switching workspaces does not write into the new project.

Inputs and outputs use workspace file paths, and uploading or reading binaries reuses `files`. The browser cannot pass Node.js Streams, loggers, or child processes, so `.pipe()`, executable-path setters, and server-side preset file loading are not provided; `preset(command => ...)` can reuse configuration inside the node. The types are `BrowserFfmpegFactory` / `BrowserFfmpegCommand`, which do not pretend to be native Node.js objects.

Unmounting the node, cancelling through the passed signal, or calling `command.kill()` cancels the request and terminates the conversion; cancelling before the start also stops FFmpeg from proceeding once it launches. The native library behind FFprobe and capability queries does not expose its child process, so cancelling only stops waiting for the query result. When FFmpeg is missing, the download prompt from Settings is reused; nothing is installed or retried automatically.

Explicit input, output, and screenshot paths go through the host's workspace and symlink checks. Indirect I/O in raw arguments, filters, and media lists is for trusted nodes only and **is not a file system sandbox**. For the native server-side API, see `packages/toolScaffold/readme.md`.

### AI model calls

The `ai` returned by `useNode()` provides text and media model lists, text generation, and media generation; you can also call `useNodeAi()` on its own in the component setup. Text generation always goes through `ai.generate()`. Streaming notifications and private tools are optional parameters, so there is no need to switch to a different method.

```ts
const { ai } = useNode();
const models = await ai.getModels();
const model = models[0];
if (!model) throw new Error("Add a model in Settings first");
const input = { providerId: model.providerId, modelId: model.modelId, prompt: "Write a short introduction" };

// Returns the complete text at once; systemPrompt can also be passed.
const result = await ai.generate(input);
console.log(result.text);

// Updates incrementally; the Promise still resolves to the complete result.
let text = "";
await ai.generate({
  ...input,
  onEvent(event) {
    if (event.type === "text") text += event.delta;
  },
});
```

- `ai.getModels(signal?)`: reads the models configured in Settings and returns `providerId`, `providerLabel`, `modelId`, `label`, `protocol`, and optional context and output lengths. `protocol` is `openai-completions`, `openai-responses`, or `anthropic-messages`. Keys and endpoint URLs are not returned.
- `ai.generate(input)`: always returns `{ text, reasoning? }`. `input` contains `providerId`, `modelId`, and `prompt`, plus optional `systemPrompt`, `references`, `directory`, `tools`, `onEvent`, and `signal`.
- `onEvent` receives text or reasoning deltas `{ type: "text" | "reasoning", delta }`, tool starts `{ type: "toolStart", id, name, args }`, and tool completions `{ type: "toolEnd", id, name, result, isError }`. Without a callback the same execution flow is used; just await the final result.
- `references` passes `STRING`, `IMAGE`, and `VIDEO` items as `{ dataType, value }` in list order, matching numbered references such as `{{ref 1}}`. Text carries its content; media carries the workspace-relative path and MIME type, and the backend validates the directory and reads the files as attachments. Media references require the absolute workspace path `directory`. Nodes do not try to predict a model's attachment support, and API errors are passed back unchanged. Video uses the Chat Completions `video_url`, while Responses and Anthropic submit it as a file; whether it is accepted depends on the provider.
- Unmounting the component aborts the browser request. In some silent SSE cases Bun 1.3.14 does not notice the disconnect promptly, so upstream generation may run to completion. Pass `signal: controller.signal` to abort earlier. HTTP errors, in-stream errors, and streams that end without a completion event all throw; the caller is responsible for showing the error. The client does not retry automatically.
- The text node keeps its previous output until new text arrives; if the stream is interrupted, the part already generated is kept.

When tool calls are needed, pass `tools: localTools` to the same entry. The type is `NodeAiTool[]`, exported from the runtime entry. Each tool contains `{ name, description, parameters, execute }`; `parameters` is a JSON Schema, and `execute(args, signal)` runs on the node side and validates its arguments. The tool loop reuses the SDK, and the browser maintains the context of the call, sending what the model needs with each request. The server only proxies individual model requests, reads keys, and handles attachments; it creates no sessions and executes no tools. Private tools are not registered in `nodeTools`, which exists only for the external main Agent to operate nodes.

A call with tools requests the model at most 40 times, and a cancel signal is sent after 10 minutes. Asynchronous tools should honor the passed `signal`; the scaffold cannot forcibly interrupt arbitrary code that ignores it. Tools that need atomic commits should modify only a private draft: after the call succeeds, the node validates and saves the draft, and discards it on error or cancellation. The scaffold cannot automatically roll back external side effects that tools have already produced.

Text AI only provides `generate({ ...input, onEvent, signal })`. The server accepts only `Context` requests and returns SSE; the old call format is not kept.


- `ai.getMediaModels(signal?)`: reads the image and video models declared by installed providers and returns provider and model IDs, names, types, and mode parameters. Image models can declare supported resolution and aspect ratio options through `imageSizes` and `imageRatios`, and nodes pass the selected values as `size` and `ratio` when generating.
- `ai.generateImage(input, signal?)`: generates without streaming, saves to disk, and returns `{ path, mimeType, mediaType: "image" }[]`. `input` contains the absolute workspace path `directory`, `providerId`, `modelId`, `prompt`, and the workspace-relative directory `outputDirectory`; `images: { path, mimeType }[]`, `ratio`, and `size` are optional. Image references pass only workspace-relative paths, which the backend reads.
- `ai.generateVideo(input, signal?)`: generates video, saves it to disk, and returns `{ path, mimeType, mediaType: "video" }[]`. The basic fields are the same as for image generation. Configure the video with `duration`, `resolution`, `ratio`, `generateAudio`, and `mode`, and optionally pass `images`, `videos`, `audios`, `firstFrame`, and `lastFrame`, all as `{ path, mimeType }` references inside the workspace.

Take a snapshot of `directory` through `files.getWorkspaceFiles().list()` before generating, and use `assets/${id}` as `outputDirectory`. The result can be assigned directly with `outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } }` and previewed with `files.useFileUrl`. The image generation node merges text references and passes image references; it replaces its output on success and keeps the previous image on failure or stop, and it cancels the request before the node is deleted. The current canvas keeps node assets to support undo, so physical files are not deleted along with the node.

### Agent node functions

Call `nodeTools.register` in the node's synchronous `setup`. You can import `nodeTools` directly from the runtime entry or take it from the return value of `useNode()`. Methods are bound to the current node ID automatically, return an unregister function, and are unregistered automatically when the component unmounts.

```ts
import { useNode, z } from "@toonflow/nodes-scaffold/runtime";

const { outputs, nodeTools } = useNode({
  handles: [{ id: "text", type: "source", dataType: "STRING" }],
  outputs: { text: { dataType: "STRING", value: "" } },
});

nodeTools.register({
  name: "setText",
  description: "Update this node's text output",
  parameters: z.strictObject({ text: z.string().min(1) }),
  execute({ text }) {
    outputs.value.text.value = text;
    return { text };
  },
});
```

Function names use lowerCamelCase; the example above appears as `node:setText`, and functions with the same name are distinguished by `nodeId`. With the Canvas Operations plugin (`画布操作`) from `packages/tools/canvas` enabled, the Agent finds nodes with `findCanvasNodes`, queries node fields and ports on demand with `getCanvasNodes`, fetches the full schema of target functions with `getNodeTools({ nodeIds: [...] })`, and calls them through the unified `nodeTools`:

```json
{ "nodeId": "<node ID>", "name": "node:setText", "args": { "text": "New content" } }
```

`parameters` uses a Zod object schema. `z` is exported by the scaffold, so nodes do not need to install Zod themselves. The parameter types of `execute` are inferred automatically, and at registration the schema is converted to a Draft 7 JSON Schema of the input type for the Agent and the server. Before executing, the frontend calls `parseAsync` on the original schema, preserving defaults, transforms, and async `refine`; the callback never runs with invalid arguments. Input types that cannot be converted to JSON Schema throw at registration.

Callbacks may be synchronous or asynchronous, and their return values must be JSON-serializable. A missing return value is sent back as `null`, and a thrown error is returned to the Agent as a tool execution error.

The registry shares the host's Vue Flow instance and is not written to the canvas JSON. Every function query reads the current registry; `addNode` returns information about the new node, whose functions can be queried with `getNodeTools` and called in the same Agent conversation turn. Functions of an unmounted node cannot be called. Switching canvases manually terminates operations on the old canvas bound to the current conversation; after the Agent creates a canvas with `addCanvas` or switches with `switchCanvas`, only the conversation that initiated the operation is rebound to the new canvas and can keep calling in the same turn. Changes go through the Vue Flow instance, and after executing them the frontend waits for the existing canvas save flow to finish before returning the result; reads do not trigger saves.

`getCanvas` returns only a canvas overview by default. `include: ["canvases"]` adds a paged list of workspace canvases (`id`, `name`), and `include: ["nodeTypes"]` adds the paged available node types. `addCanvas({ name? })` creates and selects an empty canvas, using an unused `画布N` ("Canvas N") name when `name` is omitted. `switchCanvas({ canvasId })` saves and then switches canvases. `renameCanvas({ canvasId?, name })` renames the corresponding JSON file, targeting the active canvas when `canvasId` is omitted; `name` excludes the `.json` suffix. All three return the updated overview of the active canvas, and creating or renaming never overwrites existing files.

Canvas reads are `getCanvas`, `findCanvasNodes`, `getCanvasNodes`, `getCanvasEdges`, and `getNodeTools`, all paged with a 64 KiB response limit. Check `hasMore/nextCursor` and keep the original arguments to continue paging; an empty result may not mean the scan is complete. `getCanvasNodes` takes at most 20 IDs per batch and supports field projection and `dataKeys`. Large values can be read along a `path`: strings in segments with `textOffset/textLimit`, and arrays or objects in pages with `valueOffset/valueLimit`; the returned `truncated` provides the path and offset to continue reading. Whole-graph tasks should process in batches and keep summaries instead of accumulating every detail; function schemas are always complete.

Node and edge scans cover at most 2000 items per page. `totalNodes/totalEdges` are canvas totals, not filtered match counts, and `selectedOnly` reads the live selection state. Name matching uses the full text, but name previews in lists are at most 512 characters. `nodeIds` for detail and function queries must be deduplicated, and a positive `textOffset/valueOffset` requires a `path`. Paths are at most 64 levels deep and at most 2048 bytes as UTF-8 JSON; `pathDepthLimit` indicates that the depth limit was reached. ID receipts of structural operations contain at most 100 items, and arranging, fitting the viewport, and deleting carry `arrangedCount`, `nodeCount`, and `removedEdgeCount` respectively; `truncated` only means the receipt is abbreviated, and the operation should not be run again. Business return values of `nodeTools` follow the node definitions and are not subject to the 64 KiB limit of the five read tools.

The basic canvas changes are `addCanvas`, `switchCanvas`, `renameCanvas`, `addNode`, `deleteNodes`, `moveNodes`, `renameNodes`, `connectNodes`, `deleteEdges`, `selectNodes`, and `fitCanvas`. Node content is still modified only through registered functions; the Agent is not given arbitrary write access to node `data`. Deletion first triggers the node's `delete` callback and cleans up connected edges; connecting reuses the port direction, data type, and node `canConnect` checks.

Async callbacks can take `{ signal }` from the second argument, pass it to operations such as `fetch`, and check `signal.throwIfAborted()` before changing state. A single call waits at most 120 seconds. Cancelling or switching canvases stops the wait, but async work inside the callback only stops if it honors the signal. If the browser disconnects without the runtime firing a close event, the server cleans up the pending wait on timeout.

### Top and bottom floating slots

The skeleton provides two named slots, `top` and `bottom`, whose visibility is controlled by `v-model:topVisible` and `v-model:bottomVisible`; both are hidden by default. Without a `top` slot, the default toolbar with Add to asset library, Download, and Full screen is shown on top; without a `bottom` slot, no bottom overlay is rendered. The overlays are horizontally centered 12px from the node, and the top overlay sits above the title bar so the title is not covered. Neither takes up node layout space or affects the position of the card and connection points.

`topWidth` and `bottomWidth` both default to `"20vw"`. Numbers are treated as px, and strings accept CSS widths such as percentages. For the default toolbar, `topWidth="max-content"` is recommended. Pass `downloadUrl` and `downloadName` to control downloads, and open the node's own full-screen view through `@fullscreen`. The asset library button reuses the node's outputs and the host's save dialog, and is disabled when there is no output. Extra buttons go in the `topActions` slot, before the download button; image, video, and audio nodes put their replace button there. A custom `top` slot replaces the whole toolbar. Editing overlay content does not drag the canvas or open the node context menu.

```vue
<template>
  <nodeSkeleton v-model:topVisible="topVisible" v-model:bottomVisible="bottomVisible" :bottomWidth="480">
    <template #top>Top content</template>
    <template #bottom>Bottom content</template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { nodeSkeleton } from "@toonflow/nodes-scaffold/runtime";

defineOptions({ inheritAttrs: false });
const topVisible = ref(true);
const bottomVisible = ref(false);
</script>
```

### Data types and connection validation

`dataType` follows [ComfyUI types](https://docs.comfy.org/custom-nodes/backend/datatypes) and uses case-sensitive uppercase strings: `STRING`, `INT`, `FLOAT`, `BOOLEAN`, `IMAGE`, `MASK`, `LATENT`, `AUDIO`, `VIDEO`, `MODEL`, `CLIP`, `VAE`, `CONDITIONING`; custom types are also supported. `*` is the wildcard type, `["INT", "FLOAT"]` accepts several types, and a single type can still be written as `"IMAGE"`; the old comma-separated string form is still accepted. By default, two ends can connect when their types overlap. Image outputs use `IMAGE`, and generic nodes use `*`. This is only a port compatibility declaration; it does not generate or convert data.

Only a `source` can connect to a `target`. Ports of the same kind, and missing ports or types, are always rejected. Nodes register a connection-validation callback with `nodeEvent.on("canConnect", callback)` using VueFlow's `ValidConnectionFunc` signature: `(connection, context) => boolean`. `connection` contains `source`, `target`, `sourceHandle`, and `targetHandle`; `context` contains both end nodes plus the current canvas's nodes and edges. Whichever end the drag starts from, the fields always follow the actual input/output direction, and **only the target node's callback is called; the source does not take part in validation**.

Register extra acceptance rules in the `setup` of the concrete node component. The example below limits each input port to at most two edges; inside the callback you can also read `sourceNode.id`, `sourceNode.type`, `sourceNode.data`, and the source port to restrict where connections come from. The image node only has outputs and needs no acceptance callback.

```vue
<template>
  <nodeSkeleton v-bind="nodeProps" />
</template>

<script setup lang="ts">
import { nodeSkeleton, useNode } from "@toonflow/nodes-scaffold/runtime";

defineOptions({ inheritAttrs: false });
const { nodeProps, nodeEvent } = useNode({
  handles: [
    { id: "in", type: "target", dataType: "*" },
    { id: "out", type: "source", dataType: "*" },
  ],
});

nodeEvent.on("canConnect", (connection, { edges }) => {
  // The skeleton checks type compatibility; this node only limits the number of connections per input port.
  return edges.filter(edge => edge.target === connection.target && edge.targetHandle === connection.targetHandle).length < 2;
});
</script>
```

The common validation first checks port direction, existence, and type compatibility, and only then calls the target's extra callbacks. Connections are allowed when no callback is registered. Registered callbacks must all return `true` synchronously and strictly; any other return value or a thrown exception rejects the connection, and async validation is not supported. Nodes do not need to call `isTypeCompatible` again, and returning `true` cannot bypass type restrictions. Callbacks run repeatedly while dragging and must be free of side effects.

The skeleton stores port definitions in `node.data.handles`, and events are shared per VueFlow instance and node ID, so independent UMD nodes can connect to each other. All ports go through the shared validation entry, so the target's callback is called even when the drag starts from the source. The `NodeData`, `NodeHandle`, and `NodeDataType` types as well as `isTypeCompatible` and `validateConnection` are exported from `@toonflow/nodes-scaffold/runtime`. When calling `addEdges` manually, call the validation function yourself; bypassing the drag flow does not mean validation has already happened.

## Node deletion

Nodes register delete handling with `nodeEvent.on("delete", callback)`, and the callback may be asynchronous. The skeleton awaits the handlers one by one in registration order and removes the node and its edges only after all of them succeed. With no handler, the node is removed directly; if any handler throws, deletion stops, an error is shown, and the node is kept. The delete button and the context menu share this entry. Do not clean up files when the component unmounts, or switching canvases or refreshing nodes would delete resources by mistake.

```ts
import { useNode } from "@toonflow/nodes-scaffold/runtime";

const { nodeEvent, files } = useNode();
nodeEvent.on("delete", async () => {
  await files.removeNodeFiles();
});
```

The image node calls `files.removeNodeFiles()` in its delete callback. The current canvas keeps assets through `retainNodeFiles` to support undo, so this method does not physically delete files; hosts without this retention policy clean up `assets/<nodeId>/` in the workspace, and a missing directory counts as already cleaned. Deletion is refused during an upload, and uploads are disabled during cleanup. Cleanup only affects the node's own directory and never deletes other nodes' files based on output URLs. Copied nodes may still share the original image path, so a host must account for these references before enabling physical cleanup.

## Output values and read utilities

Outputs are maintained by the `outputs` ref returned by `useNode` and passed to the skeleton with `nodeProps`. Object keys are source handle IDs, and each value is always `{ dataType, value }`. For example, once the image node has its resource ready:

```ts
import { useNode } from "@toonflow/nodes-scaffold/runtime";

const { outputs } = useNode({
  handles: [{ id: "image", type: "source", dataType: "IMAGE" }],
});
// Assign after the node's actual loading or generation logic has finished.
outputs.value.image = { dataType: "IMAGE", value: { url: "assets/example.png", mimeType: "image/png" } };
```

The initial output protocols are listed below. Media uses file references, not the Python tensors of the ComfyUI backend, and no data conversion is performed.

| dataType | value |
| --- | --- |
| STRING | string |
| INT | safe integer number |
| FLOAT | finite number |
| BOOLEAN | boolean |
| IMAGE / MASK | `{ url: string, mimeType: "image/…" }` |
| VIDEO | `{ url: string, mimeType: "video/…" }` |
| AUDIO | `{ url: string, mimeType: "audio/…" }` |

Output values must use a concrete type, never `*` or a type array; those are only for port compatibility declarations. Other port types such as `LATENT` and `MODEL` do not have a value protocol yet; when adding one, extend `NodeValueMap` and `isNodeOutput` together. The image node's output is empty before an upload and is restored from the `data.outputs` saved in the canvas on refresh.

### Image upload and workspace files

The image node picks an image through its upload button and saves it to `assets/<nodeId>/<random file name>.<extension>` in the current workspace (the directory is named `assets`). Replacing the image uses a new file name and keeps the old file, so existing references from copied nodes are unaffected. The image output is `{ dataType: "IMAGE", value: { url: "assets/...", mimeType: "image/..." } }`; `url` is a workspace-relative path, not an address that can go directly into `<img src>`.

In the node `setup`, take `files` from the return value of `useNode()`; there is no need to inject anything or call an API yourself:

```ts
import { useNode } from "@toonflow/nodes-scaffold/runtime";

const { files } = useNode();
const path = await files.uploadFile(file); // Creates the current node's directory and writes with a unique file name
const workspaceFiles = files.getWorkspaceFiles();
const bytes = await workspaceFiles.read(path);
```

`getWorkspaceFiles()` returns the host's full set of file methods: `list`, `read`, `readText`, `readJson`, `write`, `writeJson`, `rename`, `remove`, and `mkdir`. Each call binds the working directory at that moment, so multi-step operations should reuse the same return value. `uploadFile` also obtains it only once internally, so switching projects during an upload cannot write the file into another directory. File type and size validation is up to the specific node.

The canvas provides the host file capabilities through Vue `provide("workspaceFiles", factory)`, and the scaffold handles the injection without bundling Axios or Pinia. Through the optional `acquireUrl(path, mimeType)`, the host shares reads and Blob URLs for the same workspace file and returns `{ url: Promise<string>, release() }`. The URL is revoked after its last user releases it, and the cache is invalidated after the file is written, renamed, or deleted. The canvas JSON persists only relative paths and MIME types.

`files.useFileUrl(media, onError)` takes a ref, computed, or getter of `{ url, mimeType }` in `setup` and returns a URL ref that can be bound to the `src` of an image, audio, or video element. It reads the file after the node first comes near the viewport, ignores stale requests, and releases its resource reference on replacement or unmount; older hosts without `acquireUrl` fall back to plain reads. Errors are passed to `onError`. The image node only needs `const previewUrl = files.useFileUrl(image, error => showError(error, "Failed to read image"))`.

Use the utilities in the node `setup` to read a given target:

```ts
import { computed } from "vue";
import { useNode, useNodeInputs } from "@toonflow/nodes-scaffold/runtime";

const { id } = useNode();
const { getTargetSources, getTargetValues } = useNodeInputs();
const sources = computed(() => getTargetSources(id, "in"));
// Each item is { node, handle }: the upstream node object and the source port connected to this input.
const inputValues = computed(() => getTargetValues(id, "in"));
// You can also pass another target node ID: getTargetValues("otherNodeId", "imageInput").
// Each item is { source, sourceHandle, dataType, value }.
```

One input can connect to several sources, so an array is returned in canvas edge order. Disconnected connections, connections to missing ports, and type-incompatible connections return nothing. Connections that have no output yet still keep the source and the port-declared `dataType` with `value` set to `undefined`, and the reference list shows the type icon. Valid `0`, `false`, and empty strings are kept. Check `value` before reading content or starting a generation, and never send an empty reference as an attachment. An error is thrown when the output structure or type does not match the source declaration. Inside a `computed`, the results update automatically when edges, ports, or output values change. The utilities only read current values; they do not run upstream nodes or request media files.

`getTargetSources` returns the sources of a target handle in edge order and does not require the upstream node to have output. Connections with missing nodes or ports, the wrong direction, or incompatible port types are not returned; different ports of the same upstream node are kept as separate entries. Use it when you only need the connections, and `getTargetValues` when you need the actual output values.

The pure functions `getTargetSources(targetId, targetHandleId, nodes, edges)` and `getTargetValues(targetId, targetHandleId, nodes, edges)` are also exported from `@toonflow/nodes-scaffold/runtime` for logic that already has the canvas data.

### Node events

In the `setup` of a node component, take `nodeEvent` from the return value of `useNode()`, or call `useNodeEvent()` on its own. Without arguments it uses the current node; `useNodeEvent(nodeId)` uses the given node. Every registration goes through `nodeEvent.on(name, callback)`, which takes only an event name and a callback. `input:<handleId>` listens to the upstream input of a target handle, and `output:<handleId>` listens to the output of a source handle; input and output ports with the same name are listened to separately. Delete handling and connection validation use the `delete` and `canConnect` events described above. `useNodeInputs()` keeps the immediate read utilities and does not register events.

`save` callbacks should wait until node file writes have finished; throwing blocks the current switch or refresh. Ordinary saves pass no argument, while a forced refresh passes `"reload"`, so nodes whose generation or export is still running can refuse to unmount and prevent a new instance from reading unfinished content.

```ts
import { useNode, useNodeEvent } from "@toonflow/nodes-scaffold/runtime";

const { nodeEvent } = useNode();
const stopInput = nodeEvent.on("input:in", values => {
  // values: NodeInputValue[]; each item contains source, sourceHandle, dataType, and value.
});
const stopOutput = nodeEvent.on("output:text", output => {
  // output: NodeOutput | undefined, containing dataType and value.
});

useNodeEvent("otherNodeId").on("output:text", output => {
  // Listens to the given output port of another node.
});
// Call stopInput() / stopOutput() to stop early.
```

Input and output listeners are called with the current value immediately after registration. Afterward, inputs notify when edges, ports, or upstream outputs change, and outputs notify when ports or output values change, including nested fields such as the URL inside a media object. An input without valid values is `[]`, and a missing output is `undefined`. Deleting the node, removing a port, or clearing an output also triggers a notification, and valid `0`, `false`, and empty strings are kept. Type validation follows the read utilities, and invalid outputs throw.

Input and output listeners use a deep `watch` on the shared Vue instance; synchronous changes in the same tick are batched by Vue's scheduler, and upstream nodes are not executed. Do not unconditionally modify the output you are listening to inside the callback, or you will create a loop. Every `on` registration returns a cancel function. Registrations made synchronously in `setup` are cleaned up automatically when the component scope is destroyed, and you can also call the returned function to cancel early.

## Build and load

Run in the repository root:

```powershell
bun install
bun run dev:plugins
bun run dev
```

To build or watch a single node only:

```powershell
bun run --filter '@toonflow/node-image' build
bun run --filter '@toonflow/node-image' dev
```

Run the node watch command and the root `bun run dev` in two separate terminals, and refresh the host page after changing source. A default build outputs only to the root `build/nodes`. `dev:plugins` sets `NODE_ENV=dev`, and node watch mode or Vite `--mode development` also syncs the current node to `data/nodes`. Syncing writes a temporary file first and then replaces the real file, so the server never reads a half-written script; sync failures are reported as build errors.

Single-package builds do not clear these two directories, so other nodes' output is not deleted. The root `bun run build:nodes` first clears `build/nodes` and then builds all nodes, without touching `data/nodes`. Installed nodes that are no longer needed are uninstalled in Settings → Plugins.

The server serves the node list at `/api/nodes/get` from `data/nodes` and the scripts at `/api/nodes/files?name=<nodeName>`. The home page reads the list automatically, loads the corresponding `window.toonflowNodes[nodeName]`, and registers it with VueFlow; loaded nodes can be added from the context menu. There is no need to configure `VITE_NODES_URL` or start a separate server for the build output.

The Installed list supports enabling, disabling, and uninstalling. The disabled state is stored as a `data/nodes/<nodeName>.disabled` marker, which development syncs do not reset; disabled packages still appear in the Installed list, and the backend stops serving their scripts. Uninstalling deletes only the corresponding UMD and state marker in `data/nodes` and keeps the source and the `build/nodes` output; reinstalling or a development sync adds the node again. After any of these operations, the canvas add menu updates immediately, existing instances and edges on the current canvas are kept, and after a page refresh only enabled packages are loaded.

## Adding a node

1. Using `packages/nodes/imageNode` as a reference, create the source and configuration in a directory that does not exist yet (for example `packages/nodes/exampleNode`) and write the content the new node needs. Change the package name in `package.json`, for example to `@toonflow/node-example`, and change the node name in `vite.config.ts` to `exampleNode`.
2. Edit `src/index.vue`, and declare the UI framework and third-party libraries it uses in this subpackage's `dependencies`. If Sass or other build plugins are needed, add them to this subpackage's `devDependencies`.
3. Run `bun install` and `bun run dev:plugins` in the repository root to get `build/nodes/exampleNode.umd.js`, synced to `data/nodes/exampleNode.umd.js`. Start `bun run dev` or refresh an already open home page to load it; the browser export is `window.toonflowNodes.exampleNode`. To produce release artifacts only, use `bun run build:nodes`.

Node names must be unique and use lowerCamelCase. Naming the node explicitly keeps case changes in Windows toolchain paths from affecting the export name. Each package's Vite config only needs:

```ts
import { createNodeConfig } from "@toonflow/nodes-scaffold";

export default createNodeConfig({
  name: "exampleNode",
  displayName: "Example Node",
  author: "", // Author name
  github: "", // https://github.com/... URL of the author or project
}, import.meta.url);
```

`name` is the node's unique identifier and determines the file name and the VueFlow registration name; `displayName` is the name shown in Settings → Plugins. `author` may be left empty and `github` may be omitted; only the fields that are filled in are shown.

The version is maintained in each node subpackage's `package.json.version`, for example `"version": "2.0.0"`. Change this field when releasing a new version; there is no need to repeat it in the Vite config. The build requires a non-empty version string and watches `package.json` for changes.

The build writes the three display fields, `version`, `readme`, and `configRules` into the `/*! toonflowNode:{JSON} */` comment on the first line of the UMD, so no separate manifest file is needed. The server only parses this JSON, never executes node code, and returns the metadata through `/api/nodes/get`. The Installed list in Settings shows the plugin name, version, and author, and the small icon after the name opens GitHub. Older UMDs without metadata keep showing the node identifier, and the API returns an empty string when the version is missing. After changing the config or version and syncing in development, reopen the Plugins panel to refresh it.

For extra aliases, plugins, or other configuration, merge them into the node's `vite.config.ts` with Vite's `mergeConfig`. Keep the UMD format, the output directory, and the external/globals settings for all shared dependencies from the shared configuration.

### Node plugin configuration

Nodes can declare `configRules` in `createNodeConfig`, typed directly as `Rule[]` from `@form-create/element-ui`; tools use the same format and the same frontend `<form-create>` rendering. `type`, `field`, `title`, `value`, `props`, `options`, `validate`, and the rest follow the library's native rules; no separate form format is defined. Rules travel as JSON with the plugin metadata, are limited to 100 items, and must not contain functions or other non-JSON values. When the rules are undeclared or empty, the configure button is hidden. Declare required fields with `validate`:

```ts
export default createNodeConfig({
  name: "exampleNode",
  displayName: "Example Node",
  author: "",
  github: "",
  configRules: [{
    type: "input",
    field: "apiKey",
    title: "API Key",
    props: { type: "password", showPassword: true },
    validate: [{ required: true, whitespace: true, message: "Enter an API Key" }],
  }],
}, import.meta.url);
```

Users open the node's configuration form in Settings → Plugins and save it; when required configuration is missing, the configure button shows a small red dot. Configuration is saved per node type and shared by all instances of that type; it is not written to `node.data` or the canvas JSON.

```ts
const { config } = useNode();
// Read it at execution time to keep reactive updates after the configuration is saved.
const apiKey = computed(() => String(config.value.apiKey ?? ""));
```

`config` is a read-only computed that contains only the configuration of the current node type; global settings are not exposed. The host provides reactive reads through Vue `provide("nodeConfig", (nodeType: string) => config)`, and the scaffold passes the full type of the current node (for example `remote-exampleNode`). After the user saves, existing nodes receive the new configuration. Unsaved fields use the `value` defaults declared in `configRules`, and `{}` is returned when the host does not provide this capability.

## Dependency and style boundaries

- `vue` and `@vue-flow/core` are peer dependencies of nodes; the UMD directly uses `window.toonflowNodeHost.vue` and `.vueFlow` provided by the host. Nodes do not create a Vue app, and `useVueFlow()` inherits the canvas the node is on.
- `element-plus` is likewise declared as a peer dependency and reuses `window.toonflowNodeHost.elementPlus`. Import components on demand from the root entry, for example `import { ElButton } from "element-plus"`, and use `<el-button>` in templates; do not import `element-plus/es/...` or its CSS. The host loads Element Plus components and styles centrally, and node output does not bundle them again.
- The `three` core reuses `window.toonflowNodeHost.three` through external, and the host provides the full API. Nodes keep declaring the same `three` version as the host (currently `0.184.0`) and use `import { WebGLRenderer, Vector3 } from "three"` as usual, without accessing the global object directly. Extensions from `three/addons/*` and `three/examples/jsm/*` are still bundled into the node on demand, and their internal `three` references also reuse the host core; do not deep-import the core from `three/src/*`. Node UMDs and the host must use matching versions.
- The Pi SDK used by text AI likewise reuses `window.toonflowNodeHost.ai`, including `runAgentLoop` and `createAssistantMessageEventStream`, through the existing external mechanism. It is not bundled into each node UMD again, and no runtime or service is added. Node UMDs, the host, and the backend must use matching versions.
- When third-party libraries reference `@vue/runtime-core` or `@vue/runtime-dom` directly, they also use the host's Vue exports. Each node's Vue/VueFlow version must be compatible with the host; do not bring in libraries that embed their own copy of Vue, and do not import Vue's `dist` output directly.
- Other dependencies are bundled independently with each node. Different nodes may use different UI frameworks and third-party library versions, and the same library may appear in several UMDs.
- Prefer local imports for components from other UI libraries, and import the CSS they need in the node source as well. Vite's UMD mode with `cssCodeSplit: true` injects the CSS into the same JS file. For component libraries that need a provider, wrap that library's provider inside the node's root component.
- Independent subpackages provide a dependency management boundary, not page style isolation. Global CSS, resets, or libraries that rely on global installation through `app.use()` need separate adaptation. Prefer `<style scoped>` for a node's own styles.
