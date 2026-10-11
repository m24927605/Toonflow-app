import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "canvas",
  displayName: "Canvas Operations",
  description: "Adds, switches, renames and auto-arranges canvases, works with nodes, edges and the viewport, and calls functions that nodes register.",
  author: "Toonflow",
  prompt: `getCanvas reads only the canvas overview by default; use include to query the canvas list or available node types as needed. findCanvasNodes locates nodes by name, ID, type or selection state; when IDs are known, use getCanvasNodes directly to read the necessary fields, getCanvasEdges to query local edges, and getNodeTools to query the target node's functions. The user may be editing the canvas at the same time; query again after state changes and do not treat an old snapshot as the current state.
All reads have item-count and size limits; check hasMore/nextCursor and truncation information. If the list is empty but hasMore is true, keep scanning. When continuing pagination, keep the original query parameters and replace only cursor; if the cursor is invalid, query again. For whole-canvas tasks, work batch by batch, keeping only progress summaries and cursors, and do not accumulate all node details in context.
Modify the canvas with the canvas operation tools actually provided; do not write canvas JSON directly instead of using the UI operations. After creating or switching canvases, subsequent operations target the returned new canvas.
Node business parameters and execution behavior are operated through the registered nodeTools; nodeId, node:functionName and parameter structure follow what getNodeTools returns, and args are filled in according to the user's task. Do not guess unregistered functions or fields.
Before connecting, check the output port, input port and type compatibility; node positions use canvas coordinates, leaving reasonable room for content and edges. Do not create duplicates when existing nodes can be reused.
deleteNodes, moveNodes, renameNodes, connectNodes and deleteEdges each accept multiple targets at once; when multiple nodes or edges are involved, combine them into one call instead of calling for each separately. If any target fails validation, the whole call has no effect; fix it according to the returned error and resubmit the whole batch.
Wait for the result of each operation, and use getCanvasNodes/getCanvasEdges to check only the affected nodes, connections and business outputs; when a node function does not exist or the canvas is offline, state the specific problem.`,
  configRules: [],
  components: Object.fromEntries([
    "addNode", "moveNodes", "renameNodes", "nodeTools", "connectNodes",
    "deleteEdges", "selectNodes", "arrangeCanvas", "fitCanvas",
  ].map(name => [name, "src/nodeFocusCard.vue"])),
}, import.meta.url);
