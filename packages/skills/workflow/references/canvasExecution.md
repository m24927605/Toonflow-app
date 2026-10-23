# Canvas Execution

> **Seedance usage boundary:** This file only covers executing on the canvas with real model parameters and references; it takes no part in writing Seedance prompts. Whenever an executable script or timeline exists and the goal enters video production, generation, or revision, you must first enter the embedded PART A through the "Seedance route latch" in the main `SKILL.md`; **never treat the five canvas read tools, a node's `node:getConfig`, or configuration questions as an entry step that comes before Seedance.** Formal prompts must first be planned and finalized by PART A; this file must not re-segment them, rewrite the A9.1/A9.2 format, replace the Timeline, or add performance, camera-movement, or continuity rules. The user's answers to configuration questions such as aspect ratio, resolution, mode, or audio only supplement the parameters of the current Seedance task; they do not release or reset the Seedance route.

Operate on the current Toonflow canvas only with the tools actually provided this round. The following is the current contract; the live `parameters` are what calls are based on, and old examples in host documents do not override them. For the production flow see the entry point; for version and result records see [State and Delivery](stateAndDelivery.md).

## Discovery and binding

`getCanvas({})` returns only an overview of the active canvas; when you need types or the canvas list, pass `include: ["nodeTypes"]` or `["canvases"]`. Use `findCanvasNodes` to locate targets by name, type, or selection state; when node IDs are known, use `getCanvasNodes` directly to read the necessary fields, `getCanvasEdges` to read local connections, and `getNodeTools` to discover functions and their full schema. Node types may carry a runtime prefix; do not hard-code them.

The five canvas read tools are limited by item count and a 64 KiB size; continue paging by `hasMore` / `nextCursor`. Nodes and edges are scanned at most 2000 items per page, and an empty result with `hasMore: true` still requires continuing. `totalNodes/totalEdges` are canvas totals, not match counts; `selectedOnly` filters live and is not a frozen snapshot. Keep the original query parameters and replace only the cursor; if the cursor becomes invalid, query again. Process whole-canvas tasks in batches, keeping only the current batch, a summary, and the cursor in context. `getCanvasNodes` reads only `label/type/position` by default; ports, body text, and outputs must be selected explicitly with `ports/data/outputs`; `dataKeys` filters fields only when `data` is selected. Detail and function queries take at most 20 `nodeIds` per batch, deduplicated first; move, rename, delete, and connect take at most 64 items per batch.

The top-level `nextCursor` is only for continuing node paging with the original parameters. When handling any `truncated` item of a node, query only the node it belongs to, using that item's path and offset, without carrying the original `cursor`: for `text`, continue reading with that item's `path` and `nextOffset` as `textOffset`; for `entries`, use `valueOffset` instead, and a missing `nextOffset` means that path has reached its end. For `depth/budget`, narrow the scope along that item's `path` and query again without carrying the old `cursor`; `valueLimit` for objects/arrays is at most 100, `textLimit` for strings is at most 4000, and a positive offset requires `path`. A path has at most 64 levels and 2048 bytes of JSON UTF-8, with at most 256 characters per segment; `pathDepthLimit/pathBytesLimit/circular` cannot be filled in by repeating the request. For `keyTooLong`, the returned `nextOffset` can be used as `valueOffset` to skip that key and continue, but the skipped value is still unread. Do not treat truncated content as complete evidence.

By default, reuse the current project and target canvas. When an existing ledger exists, check its binding; when the user has explicitly switched targets, operate as they authorized, and when an ambiguous "continue" meets a different binding, clarify first. After creating, switching, or renaming succeeds, use the returned binding and do not keep using old IDs.

| Tool | Current parameter shape |
|---|---|
| `getCanvas` | `{include?:["canvases","nodeTypes"],cursor?,limit?,canvasId?}` |
| `findCanvasNodes` | `{query?,types?,selectedOnly?,cursor?,limit?,canvasId?}` |
| `getCanvasNodes` | `{nodeIds:[...],fields?:["label","type","position","ports","data","outputs"],dataKeys?,path?,valueOffset?,valueLimit?,textOffset?,textLimit?,cursor?,canvasId?}` |
| `getCanvasEdges` | `{nodeIds?:[...],direction?:"incoming"/"outgoing"/"both",cursor?,limit?,canvasId?}` |
| `getNodeTools` | `{nodeIds:[...],names?,cursor?,limit?,canvasId?}` |
| `addNode` | `{type, position:{x,y}, label?}` |
| `nodeTools` | `{nodeId, name:"node:functionName", args:{...}}` |
| `connectNodes` | `{connections:[{source,sourceHandle,target,targetHandle}]}` |
| `moveNodes` | `{moves:[{nodeId,position:{x,y}}]}` |
| `renameNodes` | `{renames:[{nodeId,label}]}` |
| `deleteNodes` / `deleteEdges` | `{nodeIds:[...]}` / `{edgeIds:[...]}` |
| `addCanvas` / `switchCanvas` | `{name?}` / `{canvasId}` |
| `renameCanvas` | `{canvasId?,name}` |
| `fitCanvas` / `arrangeCanvas` | `{nodeIds?}` / `{}` |

Split batch modifications into batches according to the actual count limits. `addNode` does not accept arbitrary `data`, a specified ID, or body text; use the returned `node.id` to query `getNodeTools`, then fill in content with `nodeTools` according to the full schema. The creation receipt does not include the function list. Do not call the old singular move/rename tools, and do not write canvas JSON directly.

ID receipts of structural operations may be abbreviated to at most 100 items: `arrangeCanvas` additionally gives `arrangedCount`, `fitCanvas` gives `nodeCount`, and `deleteNodes` gives `removedEdgeCount`. `truncated` only affects the returned ID list; it does not mean only the previewed part was completed. Do not repeat an operation to get the full receipt; verify with read-only tools instead. `nodeTools` returns the result of the specific business function and is not subject to the 64 KiB limit of the five read tools above.

Place content, assets, and segments from left to right following the existing layout, with items of the same stage arranged vertically, and avoid covering the user's nodes. Use `fitCanvas` to show this round's results; `arrangeCanvas` rearranges all top-level nodes, so call it only when arranging the whole canvas is within the user's scope. There is currently no grouping tool; do not fake a grouping interface.

## Content and material nodes

- For text, use the `node:setText({text})` the node actually registered. After it succeeds, read back the path with `getCanvasNodes({ nodeIds: [targetId], fields: ["data"], dataKeys: ["textPath"] })`, read the corresponding body text to verify it, and record it; `setText` currently returns only the body text, not the path. To view the current in-memory body text, read it in segments with `getCanvasNodes` using `path: ["outputs", "text", "value"]`; the persisted canvas JSON does not store this inline body text, so it cannot be used to judge that the text is empty.
- Body text is edited and saved by the node; do not write its `textPath` directly to bypass the interface. Save state files and version snapshots with the actual text file tools; a snapshot does not serve as a second editable copy of the body text.
- Mount material through the discovered `node:setImage`, `node:setVideo`, and `node:setAudio`, currently usually `{path,mimeType}`. `path` is a workspace-relative path pointing to a file that actually exists in this workspace and is readable; never fill in an expected output or an external path that has not yet been imported.
- Make new images with image generation nodes, and prefer to pin adopted images with image material nodes. The next version uses a new candidate generation node, keeping the adopted node and its connections; do not replace a source node that is still referenced downstream in order to regenerate.
- The current text node has no `generateText` the Agent can call; the assistant writes the text and then writes it in. File tools are not guaranteed to support video understanding or binary copying; for the exact limits see [Delivery](stateAndDelivery.md).

## Real references and prompts

First use the `ports` of `getCanvasNodes` to check the ID, direction, and type of the source and target ports, and use `getCanvasEdges` to check existing connections. Connect only the media adopted for this segment to the generation node; do not use edges to represent stages, approvals, or dependency indexes. Candidates upstream that are still generating or not adopted cannot become formal references.

The generation node's `prompt` is the only execution prompt entry for this run, written with `node:setPrompt({prompt})`. Full script and storyboard text nodes keep the content basis; do not also attach them to the generation node with STRING edges, because the current implementation appends the full text of connected text to the prompt. Remove existing unrelated STRING references within the authorized editing scope; otherwise explain the impact and pause that generation.

When the provider or canvas interface actually uses `{{ref N}}` as a transport reference, `{{ref N}}` may correspond only to the real connection order and types of this run; never take the order of a planned list as the real order. **This is an execution-layer mapping and does not authorize rewriting the original node/asset handles of the `Reference binding` that PART A finalized into another user-visible prompt format.** You currently need to read live data in batches to reconstruct the order; there is no `getReferences` tool:

1. Use `getCanvasEdges({ nodeIds: [targetId], direction: "incoming" })` to page through all incoming edges, keeping the returned order, and filter the edges of the actual input port. Use `getCanvasNodes` with explicit `fields: ["ports", "outputs"]` to check the source nodes in batches, confirm that the source port exists and its type is compatible, take the actual content from `outputs[sourceHandle]`, and fill in necessary fields according to the truncation information.
2. Read the target ordering with `getCanvasNodes` using `fields: ["data"], dataKeys: ["referenceOrder"]`. With `encodeURIComponent(JSON.stringify([source,sourceHandle]))` as the key, sort stably by position in `data.referenceOrder[targetPort]`; unlisted items go last and keep their original incoming-edge order. Use the valid incoming-edge order only when the field is complete and there really is no ordering record.
3. After sorting, item N corresponds to `{{ref N}}`, and different types share the numbering. An input whose output is not ready still holds its place and blocks generation; do not drop empty items and keep applying the numbering. Node/port type compatibility follows what the runtime returns.

When you cannot obtain the complete inputs or prove the order, keep the prompt draft and state what is pending verification; do not guess numbers.

The current canvas numbers references uniformly, while some provider adapters reorganize the request by image, video, and audio. By default, use real image assets plus the confirmed native audio plan; when mixed media is truly needed, verify the correspondence between the canvas order and the actual model/adapter. When consistency cannot be proven, stop at "pending reference mapping confirmation" and explain the specific conflict; never silently drop specified audio, change the mode, or falsely claim the numbering is correct.

First and last frames have explicit semantics, and a change of order may swap their roles. Use them only when the user chose that route and the real capability supports it, checking the specific input slots; do not force extracting a last frame for every segment. After connections or reference sources change, re-check references and prompts; the original authorization does not automatically cover the changed execution plan.

## Configuration questions must not cut off Seedance

- A Sulphur 2 task is never latched here: it follows the main `SKILL.md`'s Sulphur 2 route, where `node:prepareVideos` writes and preflights the prompts and this file only checks the real node settings before generation.
- Configuration verification in this file may happen only after the main `SKILL.md` has latched the Seedance route and completed the A0 target-model confirmation; if the user did not specify 2.0/2.5, the main PART A must first confirm "Seedance 2.0 or 2.5" with one short question. That model confirmation question belongs to the main PART A; this file must not choose a default model on its own or ask it again.
- If the host must confirm execution parameters such as `ratio`, `resolution`, `mode`, `generateAudio`, or provider with the user, both the question and the user's answer are supplementary execution parameters of the same Seedance task. After the answer, continue using the prompt PART A planned or finalized; do not re-enter the general workflow.
- If, in a configuration answer, the user explicitly changes the model to 2.0/2.5, this is an A0 input update: return to PART A to re-route the affected formal prompts for the new target model, then come back to this file to execute; never just switch the model at the node configuration layer while keeping the other model's prompt shell.
- If the live capability does not support the PART A target model, report the capability conflict; never silently adopt the node's default model.

## Preparation before generation

1. Call the current node's `node:getConfig` to verify the available models, modes, reference types and counts, aspect ratio, image size or video duration/resolution, native audio, and audio input capability. Judge image and video specifications separately; do not carry over unrelated defaults.
2. Connect the actual material first, then read the currently matching mode. Set the configuration through `node:setConfig`: image fields use `providerId/modelId/size/ratio` according to the schema; video uses `providerId/modelId/duration/resolution/ratio/mode/generateAudio`. Pass only the fields that are needed and supported, provide `providerId` and `modelId` as a pair, and use the actual returned value for mode.
3. When the workspace has trained LoRAs or `getConfig` lists `loras.available`, attach the ones this node needs with `node:setLoras` as [LoRA](lora.md) describes, after the model is set and before the plan is shown.
4. Write the complete prompt, then read the configuration and canvas again to check the actual prompt, references, specifications, and the output before the call. If a necessary reference is missing, stop that generation and continue the written work; never silently change image-to-image or multi-reference into a no-reference mode.
5. Fix the plan for this run: targets, quantity, complete prompt, parameters, attached LoRAs, reference files with their purposes/order, and number of executions; show it, and either carry over or obtain authorization for the specific compute consumption. When compute cost cannot be queried, state that it is unknown; do not treat conversation tokens as media consumption.
6. **Re-check right before execution.** After the user replies, read the current canvas and configuration again and compare them with the authorized plan, including nodes, prompt, mode, audio, LoRAs, references, and quantity. If something changed, carry on with the targets that still match; for affected targets, show the differences again and re-check authorization. Do not execute a configuration the interface later modified on the strength of "already confirmed".
7. When prerequisites and authorization are met, call the actual `node:generateImage` or `node:generateVideo` through `nodeTools`; the current parameter is `{}`. Do not bypass the canvas and switch to direct media tools.

Reading back and executing are not an atomic operation provided by the host. If concurrent edits still happen after the re-check, this run's output cannot be attributed from the current prompt alone; keep the attempt snapshot, mark the basis as pending verification, and do not promise to fully eliminate concurrency races.

## During generation and reading back results

The current native node returns `{status:"generating"}` immediately after starting; `getConfig` does not provide the task's final state. Record each attempt and the old output. Within the same authorized batch, other nodes that do not depend on the pending result may continue to be checked and started; nodes that depend on a base image, a variant, or the adopted result of an earlier segment must wait. Do not treat a dependency chain as an independent batch.

After finishing the independent starts and text work that can be done this round, summarize the generating nodes and the dependent to-dos, tell the user to reply when generation completes, and keep the current canvas. When there is no status/wait capability, end the round; do not fake background follow-up, poll endlessly, or present old files as new results.

After the user reports completion, use `getCanvasNodes` to read the `outputs` and necessary `data` of the relevant nodes, and check the new output, the actual file, and whether the user manually generated or replaced material in the meantime. A new path is only one piece of evidence and cannot automatically prove that it belongs to this plan; when ownership is unclear, ask which generation this output corresponds to and do not adopt it downstream yet.

If this round actually provides a new task query or wait tool, read completion, failure, and results according to its real contract, still keeping adoption and quality checks. Never invent an API, jobId, or automatic wake-up based on this paragraph.

When generation fails, times out, or is cancelled, first confirm the result state and the reason. When the tool's return is unclear, do not retry blindly, to avoid consuming compute twice; changing the plan or making extra attempts requires checking the authorized scope. When the user switches canvas or project or closes the page, nodes may be unloaded and requests aborted; after recovery, rediscover the state, with no guarantee that work continued in the background.

When results are readable, check them according to the actual capability; for video adoption and continuity into the next segment see [State and Delivery](stateAndDelivery.md). Pin only files whose adoption was actually confirmed as material nodes. When reference capability is insufficient or the user chooses external production, give the minimum necessary import requirements, without forcing an external platform.
