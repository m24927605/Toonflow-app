---
name: canvas
description: Toonflow canvas operation manual. Use the canvas tools to create, switch, and rename canvases; add, move, rename, connect, and delete nodes; automatically arrange the whole canvas and adjust the viewport; and call functions registered by nodes. Use when the user asks to operate the current canvas or build a node flow.
metadata:
  version: "2.2.0"
  displayName: 画布操作手册
  author: Toonflow
---

# Canvas Operation Manual

Control the currently running canvas through the enabled "Canvas Operations" tool. The tool is available only when a canvas context exists; when it is missing, ask the user to open the target project's canvas and confirm the tool is enabled. Do not bypass the tool by editing canvas JSON.

## Workflow

1. When node IDs are known, read the targets directly; otherwise use `getCanvas({})` to confirm the active canvas overview and `findCanvasNodes` to search by name, type, or selection state. Query types with `getCanvas({ include: ["nodeTypes"] })` only when you need to add nodes.
2. Choose the operations below according to the user's request, waiting for each return in turn. Later calls use the IDs returned by earlier steps; do not guess IDs, node types, ports, or node functions.
3. Use `getCanvasNodes` to read target fields as needed and `getCanvasEdges` to query local connections; when you need to adjust node content, use `getNodeTools` to read the description and full `parameters` of that node's functions, and call them through `nodeTools`.
4. After finishing structural changes, call `fitCanvas` as needed to show the result, then use `getCanvasNodes` / `getCanvasEdges` to check only the affected nodes, names, and connections. `arrangeCanvas` already fits the viewport automatically, so there is no need to call `fitCanvas` again. Report only the operations the tools actually completed.

For story or video production, first read [Production stages and confirmation](references/videoProduction.md#0-stage-by-stage-collaboration). By default, carry out only the currently confirmed stage; gather information step by step first, then show the stage's results and ask for adjustments, and wait for the user to explicitly continue. Do not create all storyboard and generation nodes at once just because the user says "make a short film", and do not treat a failed question, a skip, or silence as confirmation.

By default, generate character, scene, and prop assets from the complete script for this task, then split it into multi-shot segments; one segment corresponds to one video prompt and one video node, and assets are used directly for multi-reference generation. Read [Asset Image Guidelines](../script/references/assetGuide.md) before writing asset prompts and [Segment Production Guide](../script/references/productionGuide.md) before writing video prompts; a character's face close-up and complete front, side, and back three views cannot be reduced to a generic single story image.

Links in this document are relative to the current file's directory. Locate the cross-skill `script` guidelines by the actual `location` in `available_skills`; when a dependency is missing, state what is missing and continue only the structural operations that do not depend on it. Do not make up guidelines from a summary.

The notation below means "toolName(parameter object)". Call the corresponding tool directly without wrapping it in an extra `{ name, args }`; only `nodeTools` itself has `name` and `args` parameters.

## Reading the canvas

All five read tools support an optional `canvasId`, used to confirm the currently active canvas; it cannot be used to read an inactive canvas. Each response is at most 64 KiB, and no full-canvas snapshot is provided:

| Tool | Parameters and return |
| --- | --- |
| `getCanvas` | By default returns `id`, node count, edge count, selected count, and `viewport`. `include: ["canvases"]` queries the `{ id, name }` canvas list, and `include: ["nodeTypes"]` queries `availableNodeTypes` as `{ type, label }`; the two lists share paging, with `limit` defaulting to 30 and at most 100. |
| `findCanvasNodes` | Filters by `query` (ID or full name), `types` (at most 20 types), and `selectedOnly`; with filters omitted, it lists by page. Returns `nodes` summaries, with name previews of at most 512 characters; `limit` defaults to 30, at most 100. |
| `getCanvasNodes` | `nodeIds` takes 1–20 per call with no duplicates; `fields` defaults to `label/type/position`, and `ports/data/outputs` are also available. `dataKeys` limits the needed own properties of data, at most 20; returns `nodes` projections. |
| `getCanvasEdges` | `nodeIds` is optional, at most 20; `direction` takes `incoming/outgoing/both`, defaulting to `both`; only omitting IDs pages through all edges. Returns `edges`; `limit` defaults to 100, at most 200. |
| `getNodeTools` | `nodeIds` takes 1–20 per call with no duplicates, and `names` can filter by at most 20 full function names. Returns `nodeTools` (with `nodeId/name/description/parameters`); `limit` defaults to 20, at most 50. Schemas are not truncated; an item that is too large reports an explicit error. |

For paging, check `hasMore` / `nextCursor`, keep all original query parameters, and replace only `cursor`. Node filtering and edge queries scan at most 2000 items per call; even when the current `nodes` / `edges` is empty, `hasMore: true` means scanning is not finished. `totalNodes` / `totalEdges` are totals for the whole canvas, not filter match counts. Do not parse or construct cursors yourself; query again when one becomes invalid. `selectedOnly` filters by the selection state at the time each page is read, and user edits may change query results; do not treat paging as a frozen snapshot.

A single node can also be large internally. `getCanvasNodes` uses `path` to select a subpath within a projection, for example `path: ["data", "promptModel"]` or `["outputs", "text", "value"]`, and returns the `value` at that path; the first segment can only be one of the six projection fields, and `ports` corresponds to the node's `data.handles`. Arrays and objects are paged with `valueOffset` / `valueLimit`, defaulting to 0 / 30, at most 100 items; strings are segmented with `textOffset` / `textLimit`, defaulting to 0 / 1000, at most 4000 characters. When `valueOffset` or `textOffset` is greater than 0, `path` is required, to avoid misaligning all projection fields together. Paths access only own properties and cannot read inherited properties.

`path` has at most 64 levels and at most 256 characters per segment (empty keys of JSON objects are allowed), and the JSON UTF-8 length of the whole path is at most 2048 bytes. When the path depth or byte limit is reached, `pathDepthLimit` / `pathBytesLimit` is returned; never mistake that marker for having read the complete content. An overlong key is marked `keyTooLong`, with a `nextOffset` provided to continue reading later fields.

Top-level `hasMore/nextCursor` means some nodes have not been returned yet; keep the original parameters to continue node paging. Each node's `truncated` means that node's value was not fully read. When handling any truncated item, query only the node it belongs to, using that item's path and offset, without carrying the original `cursor`. Specific rules:

- `text`: continue reading with that item's `path` and `nextOffset` as `textOffset`; `entries`: continue reading with that item's `path` and `nextOffset` as `valueOffset`. A missing `nextOffset` means that path has reached its end; the marker may still be present because this call returned only the latter part.
- `depth/budget`: start a new detail query with that item's `path`, narrowing the read scope; when re-reading the path, do not carry the original query's `cursor`.
- `pathDepthLimit/pathBytesLimit/keyTooLong/circular` mean it cannot be fully expanded. For `keyTooLong`, you can skip that key with the returned `nextOffset` and continue reading later fields, but the skipped value is still not obtained; do not repeatedly retry a hard limit or treat it as complete content.

For node content, read the needed fields first, and fill in along the path only after finding truncation; do not expand into reading the whole canvas. Hand existing text file paths to the file reading tool; verifying the full text must include both the parts already read and the continued parts.

For global tasks, process page by page and record progress, keeping only the current batch, a cumulative summary, and the cursor in context; do not accumulate all the details. Adding or deleting across the whole canvas may invalidate the traversal cursor; query again and check against the processed IDs or results to avoid repeated execution. After nodes are added or deleted or the canvas is switched, rediscover the relevant functions with `getNodeTools`.

## Canvas management

| Tool | Parameters | Behavior and return |
| --- | --- | --- |
| `addCanvas` | `{ name? }` | Creates a blank canvas and switches to it; when the name is omitted, it automatically uses an unused `画布N` (Canvas N). Returns an overview of the newly active canvas. |
| `switchCanvas` | `{ canvasId }` | Waits for current changes to be saved, then switches to the specified canvas, returning an overview of the newly active canvas. |
| `renameCanvas` | `{ canvasId?, name }` | When the ID is omitted, renames the active canvas and also changes the JSON file name. Returns an overview of the active canvas after the operation. |

After trimming leading and trailing whitespace, a name is 1–120 characters, without the `.json` extension, and must be a valid file name; it cannot contain path separators, characters invalid in file names, or control characters, cannot end with a dot, and cannot use a system-reserved name. A file with the same name is never overwritten.

Canvas IDs are tied to file names; after renaming, re-read the returned ID. Renaming an inactive canvas does not switch to it. After a canvas is successfully created or switched through the tools above, later calls this round act on the new active canvas.

## Nodes and edges

| Tool | Parameters | Behavior and return |
| --- | --- | --- |
| `addNode` | `{ type, position: { x, y }, label? }` | Adds a node and returns its information; query functions with `getNodeTools`. When no name is specified, the type's `label` is used. |
| `moveNodes` | `{ moves: [{ nodeId, position: { x, y } }] }` | Moves in batch, returning `nodes` information. Nodes that cannot be dragged reject the operation. |
| `renameNodes` | `{ renames: [{ nodeId, label }] }` | Updates display names in batch, returning `nodes` information. Does not change node IDs. |
| `deleteNodes` | `{ nodeIds: [...] }` | Deletes nodes and their connected edges, returning `nodeIds`, `removedEdgeCount`, at most 100 `removedEdgeIds`, and `truncated`; truncation affects only the receipt. |
| `connectNodes` | `{ connections: [{ source, sourceHandle, target, targetHandle }] }` | Connects output and input ports in batch, returning `{ edges }`. When an identical connection already exists, the existing edge is returned. |
| `deleteEdges` | `{ edgeIds: [...] }` | Deletes the specified edges, returning `edgeIds` and the related node information `nodes`. |
| `selectNodes` | `{ nodeIds: [...] }` | Replaces the current selection, returning `selectedCount`, at most 100 `selectedNodeIds`, and `truncated`; an empty array clears the node selection. |
| `arrangeCanvas` | `{}` | Arranges the whole current canvas: lays out top-level nodes from left to right by actual node size and edges, child nodes move with their parents, and the viewport is fitted automatically. Returns `arrangedCount`, at most 100 `arrangedNodeIds`, `truncated`, and `viewport`; does not change content, edges, or selection, and does not trigger generation. |
| `fitCanvas` | `{ nodeIds?: [...] }` | Adjusts the viewport, returning `fitted`, `viewport`, `nodeCount`, and `truncated`; when `nodeIds` is passed, it also returns at most 100 `nodeIds`, and when omitted, it shows all nodes. |

The `truncated` in the receipts of the operations above means only that the ID list was abbreviated, not that the operation completed only the previewed part. Do not repeat an operation to get the full receipt; check the affected scope with the read tools as needed.

### Parameter constraints

- `position` uses canvas coordinates, not screen pixel coordinates; `x` and `y` must be finite numbers. When grid snapping is on, added and moved positions are rounded to the grid; the returned `node.position` is authoritative.
- After trimming leading and trailing whitespace, a node `label` is 1–200 characters.
- `addNode` accepts only types in the current `availableNodeTypes`, and does not accept arbitrary `data` or custom node IDs. Use registered node functions to fill in content or set node parameters.
- The move, rename, delete, and connect operations above take 1–64 items per batch, and a single item also uses the array parameter. If any item fails validation, the whole batch is not executed; an exception during execution does not mean side effects already produced are rolled back automatically, so read back before recovering.
- Top-level tool parameters use strict object validation; do not pass undeclared fields. `nodeTools.args` must also satisfy the specific node function's parameter definition.
- Node IDs, canvas IDs, and edge IDs are different identifiers; do not use display names in their place.

### Connection rules

First read the ports at both ends with `getCanvasNodes({ nodeIds: [...], fields: ["ports"] })`; each port has `id`, `type`, `dataType`, and possibly `label`. `source` and `target` are node IDs; `sourceHandle` and `targetHandle` are port IDs within their respective nodes.

- You can only connect from an output port with `type: "source"` to an input port with `type: "target"`.
- Use actual port IDs; do not guess from hint text such as "Image input". Different nodes can have ports with the same name, so always confirm the node they belong to as well.
- The tool follows the connection validation of the canvas and the target node; matching types do not guarantee a connection is allowed, as the target node may have extra rules. When a connection is rejected, check the latest ports and function descriptions; do not force the connection by editing JSON.
- Script and storyboard text are for planning and do not serve directly as inputs to image or video generation nodes. First confirm assets such as characters and scenes, then transcribe all shots of the current segment into one dedicated video prompt; edges carry only the material actually used this time.
- After connecting media, check the target's actual reference order, then use `node:setPrompt` to write `{{ref N}}`, the material names, and their purposes. A successful connection does not mean the prompt is bound to the material; for detailed numbering and configuration checks see [sections 3–4 of the production conversion](references/videoProduction.md).
- When a node or edge forbids connecting, selecting, moving, or deleting, follow the returned error. To delete a node that has child nodes, first delete the child nodes or include them in the same deletion batch; if this involves content the user did not ask to delete, clarify the scope first and do not automatically expand the deletion.

## Calling node functions

Use `nodeTools({ nodeId, name, args })`:

- `nodeId` and `name` must come from the same entry in the function list; `name` keeps the full `node:` prefix.
- Build `args` according to the JSON Schema in that entry's `parameters`, following required fields, enums, and data structures; pass `{}` even for functions with no parameters.
- Do not assume all nodes have the same set of functions; capabilities such as setting prompts, importing material, and generating media must follow what the node actually registered.
- When you need to check or change the generation configuration, if the list provides `node:getConfig`, use it to read the current configuration and available model capabilities; change the options that need changing with `node:setConfig` according to the actual parameter descriptions, then check the returned result. Configuration changes do not trigger generation; valid settings the user has confirmed stay in use, and do not re-select the model for ordinary editing tasks.
- Before image or video generation, show the actual model, targets and quantity, specifications, prompt, references, and cost, and wait for the user to explicitly approve the compute consumption plan; when the price is unknown, say it is unknown. Single images, samples, additions, regenerations, and possibly charged retries are all bound by the authorized scope, and a specific batch can be confirmed at once. Use the available `askUser`; without that tool, ask in text and wait for the answer. No answer cannot trigger generation. When no image model is specified, prefer an available gpt-image, and do not treat the node's automatic default as the user's choice; when it is unavailable, confirm an alternative model first.
- The return value is determined by the node function; it is `null` when there is no return value. The 64 KiB limit of the five canvas read tools does not apply to the execution results of `nodeTools` business functions. Successful execution does not automatically mean media generation succeeded; check the returned content and the latest node state.
- After creating a node, you can immediately query `getNodeTools` with the returned node ID and call functions, without ending the current conversation round.

## Common tasks

### Turning a creative plan into an executable canvas

When a script, novel, or creative production task needs storyboards, material, and prompts turned into nodes, read [Canvas Conversion for Video Production](references/videoProduction.md). It explains what goes into text nodes, how to reuse media and connect real dependencies, and how to verify completion of background generation. General parameters still follow this manual and the descriptions returned by the current tools.

### Creating a canvas and adding nodes

Call `addCanvas({ "name": "Storyboard Draft" })`, then query `availableNodeTypes` with `getCanvas({ "include": ["nodeTypes"] })`, and pass a type that matches the user's request as the `type` of `addNode`. For example, the position can be `{ "x": 120, "y": 160 }`; the name is determined by the user's intent. Record the returned `node.id`, query with `getNodeTools` and call functions to fill in the node content, and finally call `fitCanvas({})`.

### Connecting two existing nodes

Call `findCanvasNodes` to locate the two nodes by the name or selection state the user specified; skip the search when IDs are known, and if nodes with the same name cannot be told apart, clarify the targets first. After reading the output and input ports with `getCanvasNodes`, fill the actual IDs into the `connections` array of `connectNodes`. Check both ends of the returned `edges`, then focus on these two nodes as needed.

### Finding and reading a specified segment

For example, when the user specifies G51, first call `findCanvasNodes({ "query": "G51", "limit": 20 })` and confirm the target from the paged results. Replace `targetId` below with the actual returned ID:

- Check the prompt and output: `getCanvasNodes({ "nodeIds": ["targetId"], "fields": ["label", "data", "outputs"], "dataKeys": ["prompt", "referenceOrder"] })`. The default fields do not include `ports/data/outputs`; do not treat fields you did not request as empty.
- Read a long prompt: `getCanvasNodes({ "nodeIds": ["targetId"], "path": ["data", "prompt"], "textLimit": 4000 })`; afterwards use the returned `nextOffset`, and do not calculate it yourself from the requested length.
- Query the target's incoming edges: `getCanvasEdges({ "nodeIds": ["targetId"], "direction": "incoming", "limit": 100 })`; query callable functions: `getNodeTools({ "nodeIds": ["targetId"], "limit": 20 })`.

### Arranging nodes in bulk

Only when the user explicitly asks to arrange the whole current canvas, call `arrangeCanvas({})` once after confirming the target; do not calculate coordinates for all nodes yourself and move them one by one. This tool reuses the canvas's existing arrange feature and does not accept `nodeIds` or any other partial scope parameter.

When nodes to be arranged have not been measured yet or cannot be moved, the tool returns an explicit error; do not guess sizes or bypass movement restrictions. An empty canvas normally returns an empty `arrangedNodeIds` and performs no layout or viewport adjustment.

When arranging only specified shots or some nodes, read their actual positions and the target area, adjust these nodes with the `moves` array of `moveNodes`, and show them with `fitCanvas({ "nodeIds": [...] })` as needed. When the user only wants to see content clearly, use `fitCanvas` directly without rearranging nodes. Never call `arrangeCanvas` for partial arrangement and move the user's other nodes, and do not delete or rebuild nodes instead of moving them.

## Handling failures

- Node type not enabled, port does not exist, function not registered: query the latest state with `getCanvas({ include: ["nodeTypes"] })`, `getCanvasNodes`, and `getNodeTools` respectively and adjust the operation; do not guess substitute functions.
- The canvas was closed, the user manually switched project or canvas, or this round's context became invalid: stop using the old IDs and ask the user to resend the request on the target canvas.
- A timeout, cancellation, or save failure does not mean the operation was rolled back. While the context is still valid, first read the latest canvas state to confirm whether nodes, edges, or canvases were created, then decide whether to retry, avoiding duplicate creation or duplicate generation triggers.
- The tool waits for operations that need saving to finish saving; do not separately write canvas JSON directly. The current tools provide no general interface for deleting canvases, writing arbitrary node data, or setting arbitrary viewport parameters.
