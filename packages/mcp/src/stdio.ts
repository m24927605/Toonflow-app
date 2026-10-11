#!/usr/bin/env node
import { readFile, stat } from "@toonflow/file";
import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { detectLocale, msg, translate } from "@toonflow/i18n";

const locale = detectLocale([Intl.DateTimeFormat().resolvedOptions().locale]);
function t(strings: TemplateStringsArray, ...values: unknown[]) { return translate(msg(strings, ...values), undefined, locale); }

async function main() {
  const { values } = parseArgs({ options: {
    url: { type: "string" },
    "token-env": { type: "string", default: "TOONFLOW_MCP_TOKEN" },
    runtime: { type: "string" },
    help: { type: "boolean" },
  } });
  if (values.help) {
    process.stderr.write(t`toonflow-mcp --url <MCP URL> --token-env <environment variable name>
toonflow-mcp --runtime <run information file>
`);
    return;
  }
  if (Boolean(values.url) === Boolean(values.runtime)) throw new Error("Please specify --url or --runtime, you can only choose one of the two.");
  let endpoint = values.url;
  let token = process.env[values["token-env"]];
  if (values.runtime) {
    const info = await stat(values.runtime);
    if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
      throw new Error("The running information file must belong to the current user and is only allowed to be accessed by the current user (chmod 600)");
    }
    const runtime = z.object({ pid: z.number().int().positive(), url: z.url(), token: z.string().min(1) }).parse(JSON.parse(await readFile(values.runtime, "utf8")));
    process.kill(runtime.pid, 0);
    endpoint = runtime.url;
    token = runtime.token;
  }
  if (!token) throw new Error(t`MCP access credential not found, please set ${values["token-env"]}`);
  const url = new URL(endpoint!);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!(["http:", "https:"].includes(url.protocol)) || (url.protocol === "http:" && !local)) {
    throw new Error("Remote MCP must use HTTPS; local connection allows HTTP");
  }
  if (values.runtime && !local) throw new Error("The running information file is only allowed to point to the local Toonflow");
  if (url.username || url.password) throw new Error("The MCP URL cannot contain a username or password");
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, "Accept-Language": locale } },
  });
  const client = new Client({ name: "toonflow-stdio", version: "0.0.0" });
  await client.connect(transport);
  if (!client.getServerCapabilities()?.tools) {
    await client.close();
    throw new Error("Target service does not provide MCP tools");
  }
  const bridge = serveStdio(() => {
    const resources = client.getServerCapabilities()?.resources;
    const server = new McpServer({ name: "toonflow", version: "0.0.0" }, {
      capabilities: { tools: { listChanged: false }, ...(resources ? { resources: { subscribe: false, listChanged: false } } : {}) },
      instructions: client.getInstructions(),
    });
    server.server.setRequestHandler("tools/list", (request, context) => client.listTools(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" }));
    server.server.setRequestHandler("tools/call", (request, context) => client.callTool(request.params, { signal: context.mcpReq.signal, timeout: 30 * 60_000 }));
    if (resources) {
      server.server.setRequestHandler("resources/list", (request, context) => client.listResources(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" }));
      server.server.setRequestHandler("resources/read", (request, context) => client.readResource(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" }));
      server.server.setRequestHandler("resources/templates/list", (request, context) => client.listResourceTemplates(request.params, { signal: context.mcpReq.signal, cacheMode: "refresh" }));
    }
    return server;
  }, { onerror: error => console.error(error.message) });
  const close = async () => {
    await bridge.close();
    await transport.terminateSession().catch(error => console.error(error instanceof Error ? error.message : String(error)));
    await client.close();
  };
  process.stdin.once("end", () => void close());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch(error => {
  console.error(translate(error instanceof Error ? error.message : String(error), undefined, locale));
  process.exitCode = 1;
});
