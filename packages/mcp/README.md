# @toonflow/mcp

The standalone MCP adapter package for Toonflow. The host provides a separate local HTTP listening port while keeping the existing Server's `/mcp` path; the stdio entry only connects to a running Toonflow and does not start a second app process. It uses the Streamable HTTP session transport from the official MCP TypeScript SDK v2, is compatible with 2025 client protocol versions, and supports canceling tool calls.

Verified: initialization with `2025-03-26`, `2025-06-18` and `2025-11-25`, automatic negotiation fallback in SDK v2, and HTTP/stdio tool calls and cancellation. The 2026 sessionless HTTP protocol is not enabled.

## Enabling

1. Start Toonflow and open **Settings → MCP**.
2. Turn on the MCP switch, then copy the connection address and the client configuration.
3. Add the MCP server in your external coding tool, reconnect, and call `getAppState`.

The switch is off by default. The access token is managed in Settings; turning MCP off or replacing the token cancels control calls in progress. UI operations such as canvases, nodes, the current document and switching projects require an open Toonflow window or web page. Server-side file, skill and media capabilities can use a specified workspace directory without a frontend connection; on Linux deployments the directory must be inside `data/workspaces`.

The default local MCP address is `http://127.0.0.1:10588/mcp`, and it only listens on the loopback address. You can change the preferred port manually in **Settings → MCP**; after saving, the MCP service switches automatically without restarting Toonflow. The MCP port is independent of the desktop page's random port, and switching it only affects the MCP listener.

If the preferred port is already in use, the instance tries the following ports in turn and reports a failure if it still cannot listen after reaching the retry limit. When switching ports, it listens on the new address first and closes the old one only after that succeeds; if the switch fails, the old address is kept and the error is shown in Settings. When several instances are open, each uses its own actual address, for example `10588` or `3002`; copy the configuration from the settings of the target instance. The actual fallback port does not overwrite the saved preferred port, and an existing instance does not migrate automatically when a lower port becomes free. Instances sharing the same `data` directory share the preferred port, the MCP switch and the access token; after a new preferred port is saved, each instance applies it automatically and falls back separately. These settings are not per-window.

After the actual address changes, copy the external client's HTTP or stdio configuration again from the target instance and reconnect.

## Streamable HTTP

Enter the MCP address shown in Settings into a client that supports HTTP, and set the request header:

```text
Authorization: Bearer <access token from Settings>
```

Configuration fields differ between clients; a common structure is:

```json
{
  "mcpServers": {
    "toonflow": {
      "url": "http://127.0.0.1:<actual port>/mcp",
      "headers": { "Authorization": "Bearer <access token>" }
    }
  }
}
```

When Settings is opened locally, it shows the separate MCP listening address; when opened remotely, it keeps `/mcp` under the page's public address. For remote Linux deployments, forward the host Server's `/mcp` through an HTTPS reverse proxy, keep the Authorization header, and do not put the access token in the URL; the local loopback listening address cannot be used directly for remote connections.

The MCP token only protects the MCP entry. The existing Web pages and their APIs are themselves the management interface and are not covered by a site-wide authentication scheme; remote Linux deployments should protect the whole site with deployment-side measures such as reverse proxy authentication or a private network.

## stdio

Prefer clicking **Copy stdio configuration** in the settings of the target instance; it already contains the absolute paths of the current host's runtime, entry artifact and runtime info file. The following only illustrates the configuration structure:

```json
{
  "mcpServers": {
    "toonflow": {
      "command": "node",
      "args": ["<absolute path to build/mcp/stdio.js>", "--runtime", "<absolute path to the runtime info file>"]
    }
  }
}
```

Runtime info is saved per actual MCP port, for example `data/mcpRuntime10588.json` or `data/mcpRuntime3002.json`, and is only generated while MCP is enabled. The format is `{ "pid": process ID, "url": "http://127.0.0.1:port/mcp", "token": "access token" }`, maintained by the host; on shutdown or exit, the host only deletes files that still belong to the current process. Only local addresses may be connected; on macOS/Linux the file must belong to the current user and have permission `0600`.

The stdio configuration is bound to the actual port within the selected data directory and does not follow any particular window. After changing the preferred port or restarting, if the actual port changes, copy the configuration again from the target instance; if the same port is obtained after a restart, just reconnect MCP. When the order in which instances are opened changes, the same port may belong to another instance; check the target instance's actual address before connecting, and confirm the page and workspace with `getAppState`. MCP sessions are maintained separately for each instance.

The legacy shared `data/mcpRuntime.json` is no longer maintained as a runtime info alias; copy the stdio configuration again after upgrading.

You can also pass the URL explicitly and read the access token from an environment variable:

```json
{
  "mcpServers": {
    "toonflow": {
      "command": "node",
      "args": ["<absolute path to build/mcp/stdio.js>", "--url", "https://<service domain>/mcp", "--token-env", "TOONFLOW_MCP_TOKEN"],
      "env": { "TOONFLOW_MCP_TOKEN": "<access token>" }
    }
  }
}
```

Node.js 20 or later is required; Bun is also supported. For source development, use `bun packages/mcp/src/stdio.ts`. stdio's stdout only carries MCP messages, and errors are written to stderr; it bridges tool listing and calls, as well as resource listing, reading and template listing, preserving cancellation signals. Each tool call waits at most 30 minutes, and asynchronous generation nodes return the start result according to the node contract.

## Skill

`skills/toonflow/SKILL.md` is intended for external Agents. It is packaged into `build/mcp/skills/toonflow/SKILL.md` and can also be exported from Settings. Put the whole `toonflow` directory into the Skill directory supported by your external tool.

The Skill describes the order of operations for the live canvas, node parameters, media references and generation results. Connecting MCP does not install the Skill automatically; tools can still be called from their descriptions without the Skill.

## Global skill resources

The main files and supporting files of skills installed in the global `data/skills` are provided to external Agents as standard MCP resources:

1. Call `resources/list` to discover the files and their URIs.
2. Pass a returned URI to `resources/read` to read the skill or supporting material you need.

The URI structure is `toonflow://skills/<encoded skill name>/<encoded path segments within the skill>`. The skill name is encoded as a whole with `encodeURIComponent`, and each segment of the file path is encoded separately, keeping the `/` hierarchy; just use the URIs returned by the listing, without guessing disk paths.

Resources and tools share the MCP switch and the Bearer token. Each request reads the latest directory or file, and the stdio bridge also refreshes upstream resources, so skill content is not cached; resource subscriptions and change notifications are not provided, and the template list is empty. Reading resources does not run scripts in skills, nor does it install the Skill into external clients automatically.

## Tool conventions

`getAppState` takes `{}` and is used first to discover connections and workspaces. Other business tools use the structure below; the fields actually available are defined by the JSON Schema returned by `tools/list`:

```json
{
  "target": { "connectionId": "connection ID", "directory": "absolute workspace path", "canvasId": "current canvas ID" },
  "args": { "originalToolParameter": "value" }
}
```

`target` and its fields are optional. When operating on a canvas, pass `connectionId`, `directory` and `canvasId` explicitly, so that an old command does not act on a new canvas after the user switches canvases manually. After successfully switching projects or canvases, read the state again and update the target IDs.

Canvas tools share their existing implementation with the built-in Agent. `getCanvas` returns an overview by default and can include a paginated canvas list or node types on request; `findCanvasNodes` filters and locates nodes, `getCanvasNodes` reads details by ID and field, `getCanvasEdges` queries local connections with pagination, and `getNodeTools` returns the full function schemas of a target node, which are then called through `nodeTools`. Each read is limited to 64 KiB; continue with `hasMore/nextCursor`, and note that an empty result may still require further scanning. Large node fields can be read in segments with `path` plus `textOffset/textLimit` or `valueOffset/valueLimit`. Whole-graph tasks proceed in batches and keep a summary and cursor, without injecting the full set of node functions. Disabled plugins, mismatched targets and disconnections return explicit errors.

Node/edge queries scan at most 2000 items per page; `totalNodes/totalEdges` are canvas totals, and `selectedOnly` filters on the current selection at the time of the call. Name matching covers the full text, and name previews in results are at most 512 characters. Node IDs in detail and function queries must not repeat; a positive offset requires `path`, and paths are limited to 64 levels and 2048 JSON UTF-8 bytes, with `pathDepthLimit` indicating that the depth limit was reached. ID receipts for arrange, fit-viewport and delete are limited to 100 items and include the actual count and a truncation flag; do not repeat an operation because its receipt was abbreviated. The business return values of `nodeTools` are not subject to the 64 KiB limit of the five read tools.

| Capability | How to call |
| --- | --- |
| App management | `listAppOperations` with `{ "args": {} }` lists the current 31 management operations, or `{ "args": { "name": "operationName" } }` returns the description and schema of one operation; then `appOperation` with `{ "args": { "name": "operationName", "parameters": {} } }` runs it. Covers plugins, skills, media providers, the asset library and Agent history; the operation list and schemas actually returned are authoritative. |
| Session management | Call the corresponding operation through `appOperation`. The working directory is injected from `target.directory` or the workspace of the specified page; do not add a directory in `parameters`. |
| Delegating to the built-in Agent | Call `runAgent` when the user requests it. `args` provides `providerId`, `modelId` and `prompt`, plus an optional `sessionFile` to continue an existing conversation; it waits for the current turn to finish and returns the reply and the conversation file. The call uses the configured model. |
| File and media transfer | The `action` of `workspaceFiles` supports `list`, `mkdir`, `rename`, `remove`, `readBinary` and `writeBinary`. Binary data is transferred as Base64 and may not exceed 20 MiB after decoding; writes default to `exclusive: true` and do not overwrite existing files. Text reading and writing reuse the enabled file tools. |
| Document editing | First call `getDocument` to get `text`, then call `writeDocument` with the new `text` and the original text as `expectedText`; the write is rejected if the original text does not match. Raw file operations on open canvases and documents are rejected; use the corresponding UI tools instead. |

Sensitive fields such as provider keys are shown as `[REDACTED]` in management results. Do not write a redacted object back as a whole; submit the fields you need to change according to the operation schema, and enter real values when a key is required.

## Host integration

```ts
import { createMcpRouter } from "@toonflow/mcp";

const mcp = createMcpRouter({
  getTools: async () => tools,
  authorize: request => verifyMcpAccess(request),
  resources: {
    list: signal => listGlobalSkillFiles(signal),
    read: (uri, signal) => readGlobalSkillFile(uri, signal),
  },
});
app.use("/mcp", mcp);
```

Each tool has `name`, `description`, `inputSchema` (JSON Schema) and `execute(args, signal)`. The SDK validates tool input; ordinary results are converted into text and structured results, while the content of existing tools is kept as MCP content blocks; execution errors return `isError: true`. `mcp.close()` releases protocol resources, and the host handles cancellation of business tasks at the same time.

`resources` is optional; when provided, the MCP resources capability is declared. `list(signal)` returns `Promise<Resource[]>` and `read(uri, signal)` returns `Promise<ReadResourceResult>`; both official SDK types can be imported from `@toonflow/mcp`. Directory scanning, URI validation, file reading and permission checks are implemented by the host; the package handles protocol forwarding and passing cancellation signals.

The host is responsible for the MCP switch, the Bearer token, Host/Origin validation and workspace permissions. The package does not depend on `apps/server/src` or frontend components, and does not create its own HTTP listening port.

```sh
bun run --filter @toonflow/mcp typecheck
bun run --filter @toonflow/mcp build
```

The artifacts are in `build/mcp/`, including the HTTP module, the stdio entry, the README and the Skill. The SDK needed by stdio is bundled, so it can run directly with Node.js/Bun; when importing the HTTP module on its own, the host must provide Express 5.
