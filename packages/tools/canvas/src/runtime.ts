import { z } from "zod";
export type { CanvasToolCall, CanvasInfo, CanvasContext } from "@toonflow/tools-scaffold/runtime";

const nodeId = z.string().min(1).max(256);
const position = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const canvasId = nodeId.optional();
const cursor = z.string().min(1).max(4096).optional();
const nodeIds = z.array(nodeId).min(1).max(20);

export const canvasSchemas = {
  getCanvas: z.strictObject({
    canvasId,
    include: z.array(z.enum(["canvases", "nodeTypes"])).max(2).optional(),
    cursor,
    limit: z.number().int().min(1).max(100).default(30),
  }),
  findCanvasNodes: z.strictObject({
    canvasId,
    query: z.string().max(200).optional(),
    types: z.array(nodeId).max(20).optional(),
    selectedOnly: z.boolean().optional(),
    cursor,
    limit: z.number().int().min(1).max(100).default(30),
  }),
  getCanvasNodes: z.strictObject({
    canvasId,
    nodeIds: nodeIds.refine(value => new Set(value).size === value.length, "nodeIds must not contain duplicates; deduplicate first"),
    fields: z.array(z.enum(["label", "type", "position", "ports", "data", "outputs"])).max(6).default(["label", "type", "position"]),
    dataKeys: z.array(nodeId).min(1).max(20).optional(),
    path: z.array(z.string().max(256)).min(1).max(64)
      .refine(value => ["label", "type", "position", "ports", "data", "outputs"].includes(value[0]!), "path must start with a node projection field")
      .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2048, "The JSON UTF-8 length of path must not exceed 2048 bytes").optional(),
    valueOffset: z.number().int().min(0).default(0),
    valueLimit: z.number().int().min(1).max(100).default(30),
    textOffset: z.number().int().min(0).default(0),
    textLimit: z.number().int().min(1).max(4000).default(1000),
    cursor,
  }).refine(value => Boolean(value.path) || (value.textOffset === 0 && value.valueOffset === 0), "path is required when textOffset or valueOffset is greater than 0"),
  getCanvasEdges: z.strictObject({
    canvasId,
    nodeIds: nodeIds.optional(),
    direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
    cursor,
    limit: z.number().int().min(1).max(200).default(100),
  }),
  getNodeTools: z.strictObject({
    canvasId,
    nodeIds: nodeIds.refine(value => new Set(value).size === value.length, "nodeIds must not contain duplicates; deduplicate first"),
    names: z.array(nodeId).min(1).max(20).optional(),
    cursor,
    limit: z.number().int().min(1).max(50).default(20),
  }),
  addCanvas: z.strictObject({ name: z.string().trim().min(1).max(120).optional() }),
  switchCanvas: z.strictObject({ canvasId: z.string().min(1).max(256) }),
  renameCanvas: z.strictObject({ canvasId: z.string().min(1).max(256).optional(), name: z.string().trim().min(1).max(120) }),
  addNode: z.strictObject({ type: z.string().min(1), position, label: z.string().trim().min(1).max(200).optional() }),
  deleteNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(64) }),
  moveNodes: z.strictObject({ moves: z.array(z.strictObject({ nodeId, position })).min(1).max(64) }),
  renameNodes: z.strictObject({ renames: z.array(z.strictObject({ nodeId, label: z.string().trim().min(1).max(200) })).min(1).max(64) }),
  connectNodes: z.strictObject({
    connections: z.array(z.strictObject({ source: nodeId, sourceHandle: z.string().min(1), target: nodeId, targetHandle: z.string().min(1) })).min(1).max(64),
  }),
  deleteEdges: z.strictObject({ edgeIds: z.array(z.string().min(1).max(256)).min(1).max(64) }),
  selectNodes: z.strictObject({ nodeIds: z.array(nodeId) }),
  arrangeCanvas: z.strictObject({}),
  fitCanvas: z.strictObject({ nodeIds: z.array(nodeId).optional() }),
  nodeTools: z.strictObject({ nodeId, name: z.templateLiteral(["node:", z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/)]), args: z.record(z.string(), z.json()) }),
};

export type CanvasOperationName = keyof typeof canvasSchemas;

export const canvasOperations = [
  { name: "getCanvas", label: "Canvas overview", description: "Read the active canvas's ID, node count, edge count, selection count and viewport, without returning all nodes, edges or functions. include optionally selects canvases (canvas list) or nodeTypes (availableNodeTypes), which share cursor/limit pagination. When node IDs are known, read the nodes directly. Every read tool returns at most 64 KiB per call along with hasMore/nextCursor; continuing pagination must keep the original parameters and replace only cursor. Query again if the cursor becomes invalid. canvasId is optional and verifies that the target is still the active canvas. Do not modify canvas JSON directly.", parameters: canvasSchemas.getCanvas },
  { name: "findCanvasNodes", label: "Find canvas nodes", description: "Filter nodes by query (node ID or full name), types and selectedOnly; when filters are omitted, list them with pagination. Returns brief nodes information with name previews of at most 512 characters, without body text or function definitions. limit defaults to 30, at most 100, and each call scans at most 2000 nodes. totalNodes is the total number of nodes on the canvas, not the number of matches; selectedOnly filters by the selection state at the time each page is read, not a frozen snapshot. Even if nodes is empty, when hasMore is true you must continue scanning with nextCursor. When processing all nodes, work batch by batch, keeping summaries and cursors, and avoid piling up the details of each page in context.", parameters: canvasSchemas.findCanvasNodes },
  { name: "getCanvasNodes", label: "Read node details", description: "Read up to 20 nodes by known, non-duplicate nodeIds; fields defaults to label/type/position, and ports, data and outputs can be specified as needed. dataKeys selects only own properties of data. path reads a nested value under a projection field, such as ['data','promptModel'], accessing own properties only; ports corresponds to data.handles. path returns value; arrays/objects are paginated by valueOffset/valueLimit (default 30, at most 100), and strings are segmented by textOffset/textLimit (default 1000, at most 4000 characters). path is required when textOffset or valueOffset is greater than 0. Check each node's truncated path, total and nextOffset, and continue reading along that path; do not treat truncated data as complete. Existing text file paths should be passed to the file reading tool. Responses are limited to 64 KiB; when hasMore, keep the parameters and continue with nextCursor.", parameters: canvasSchemas.getCanvasNodes },
  { name: "getCanvasEdges", label: "Read canvas edges", description: "Read the local edges related to nodeIds with pagination; direction is incoming/outgoing/both, default both. When nodeIds is omitted, traverse all edges on the canvas with pagination; limit defaults to 100, at most 200, and each call scans at most 2000 edges. totalEdges is the total number of edges on the canvas, not the number of matches. Returns edges and pagination information; if edges is empty but hasMore is true, continue with nextCursor. When querying upstream, limit the scope level by level instead of expanding the whole graph at once.", parameters: canvasSchemas.getCanvasEdges },
  { name: "getNodeTools", label: "Query node functions", description: "Query the actually registered functions for up to 20 non-duplicate nodeIds; names can filter by full node:functionName, and limit defaults to 20, at most 50. Returns nodeTools, each with nodeId/name/description/parameters; function schemas are kept complete, and an explicit error is reported when a single item is too large. Build arguments from the queried schema before calling nodeTools; do not guess function names or parameters. When hasMore, continue with nextCursor.", parameters: canvasSchemas.getNodeTools },
  { name: "addCanvas", label: "Add new canvas", description: "Create a blank canvas JSON in the current workspace and switch to the new canvas. name is optional and has no .json extension; when omitted, an unused default name in the UI language is used automatically (such as \"Canvas N\" in English), and files with the same name are not overwritten. Returns the new canvas state; later calls in this turn can continue adding nodes.", parameters: canvasSchemas.addCanvas },
  { name: "switchCanvas", label: "Switch canvas", description: "First get the canvasId by paginating getCanvas({include:['canvases']}), then switch the active canvas. Waits for current changes to be saved and returns the new canvas overview; subsequent operations in this turn apply to the new canvas.", parameters: canvasSchemas.switchCanvas },
  { name: "renameCanvas", label: "Rename canvas", description: "Rename a canvas in the current workspace, also renaming its JSON file. When canvasId is omitted, the active canvas is renamed; name has no .json extension. Existing files are not overwritten. Returns the active canvas overview after the operation.", parameters: canvasSchemas.renameCanvas },
  { name: "addNode", label: "Add node", description: "Add a node at canvas coordinates position on the active canvas; type must come from availableNodeTypes in getCanvas({include:['nodeTypes']}). Returns information about the new node; query node functions as needed with getNodeTools.", parameters: canvasSchemas.addNode },
  { name: "deleteNodes", label: "Delete node", description: "Delete the nodes with the specified nodeIds and their connected edges from the active canvas in one batch; parent and child nodes in the same batch can be deleted together, and if any node fails validation, nothing is executed. Returns removedEdgeCount, up to 100 removedEdgeIds, and truncated; truncation only affects the deletion receipt and does not mean only some edges were deleted.", parameters: canvasSchemas.deleteNodes },
  { name: "moveNodes", label: "Move nodes", description: "Move the specified nodes on the active canvas to their respective canvas coordinates position in one batch; multiple nodes can be passed at once, and if any item fails validation, nothing is executed.", parameters: canvasSchemas.moveNodes },
  { name: "renameNodes", label: "Rename nodes", description: "Change the display names of the specified nodes on the active canvas in one batch; multiple nodes can be passed at once, and if any item fails validation, nothing is executed.", parameters: canvasSchemas.renameNodes },
  { name: "connectNodes", label: "Connect nodes", description: "Connect output ports sourceHandle to input ports targetHandle on the active canvas in one batch; multiple connections can be passed at once. First confirm the target nodes and ports with the ports field of getCanvasNodes; the canvas and node connection validation applies, and if any item fails validation, nothing is executed.", parameters: canvasSchemas.connectNodes },
  { name: "deleteEdges", label: "Delete edges", description: "Delete the edges with the specified edgeIds from the active canvas in one batch; if any item fails validation, nothing is executed.", parameters: canvasSchemas.deleteEdges },
  { name: "selectNodes", label: "Select nodes", description: "Select the nodes with the specified nodeIds on the active canvas; pass an empty array to clear the node selection.", parameters: canvasSchemas.selectNodes },
  { name: "arrangeCanvas", label: "Arrange canvas", description: "Automatically arrange all top-level nodes on the active canvas from left to right based on actual node sizes and edges, then fit the view. Child nodes keep their relative positions; content, edges and selection are not changed, and no generation is triggered. Returns arrangedCount, up to 100 arrangedNodeIds, truncated and viewport; truncated only means the ID receipt is abbreviated, not that only some nodes were arranged. Arrangement is refused when node sizes are not ready or there are immovable nodes. Call only when the whole canvas needs arranging; use moveNodes for local adjustments and fitCanvas for simply viewing.", parameters: canvasSchemas.arrangeCanvas },
  { name: "fitCanvas", label: "Fit canvas", description: "Adjust the active canvas viewport to show the nodes specified by nodeIds; when nodeIds is omitted, show all nodes. Returns fitted, viewport and nodeCount, plus up to 100 nodeIds and truncated when nodeIds is passed; truncation only affects the receipt.", parameters: canvasSchemas.fitCanvas },
  { name: "nodeTools", label: "Call node function", description: "Call a node:functionName registered by a node on the active canvas. First read the complete parameters of that node's actual function through getNodeTools, then fill in args according to the schema. A newly created node can be queried and called in the same turn; do not modify canvas JSON in place of node functions. The return value is determined by the specific business function, and the 64 KiB limit of the five canvas read tools does not apply to this execution entry point.", parameters: canvasSchemas.nodeTools },
] as const;
