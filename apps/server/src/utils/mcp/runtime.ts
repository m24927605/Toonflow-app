import { t } from "@/lib/i18n";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, writeAtomicSync } from "@toonflow/file";
import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import type { Socket } from "node:net";
import type { Express } from "express";
import conf from "@/utils/conf";
import { getMcpSettings } from "@/utils/mcp/control";

let runtime: { app: Express; appOrigin: string; requestHeaders: Record<string, string>; server?: Server; sockets?: Set<Socket>; url?: string; port?: number; preferredPort?: number; file?: string; command: string; entry: string; error?: string } | undefined;
let reloadQueue = Promise.resolve();

function removeRuntime(file?: string) {
  if (!file) return;
  // ACT: The file is reused per port; only clean up our own record
  // and never delete another instance that took over this port.
  try {
    if (JSON.parse(readFileSync(file, "utf8")).pid === process.pid) rmSync(file, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("清理 MCP 运行信息失败：", error);
  }
}

function saveRuntime(value = runtime) {
  const { enabled, token } = getMcpSettings();
  if (!value?.file) return;
  if (enabled && token.length >= 32) {
    writeAtomicSync(value.file, JSON.stringify({ pid: process.pid, url: value.url, token }), { mode: 0o600 });
  } else removeRuntime(value.file);
}

export function initializeMcpRuntime(app: Express, url: string, entry: string, command = process.execPath, requestHeaders: Record<string, string> = {}) {
  runtime = { app, appOrigin: new URL(url).origin, entry, command, requestHeaders: { ...requestHeaders } };
  return reloadMcpRuntime();
}

export function getAppRequestHeaders() {
  return { ...runtime?.requestHeaders };
}

export function stopMcpRuntime() {
  reloadQueue = reloadQueue.catch(() => {}).then(async () => {
    const current = runtime;
    runtime = undefined;
    removeRuntime(current?.file);
    if (!current?.server) return;
    await new Promise<void>(resolve => {
      current.server!.close(() => resolve());
      for (const socket of current.sockets ?? []) socket.destroy();
    });
  });
  return reloadQueue;
}

export function reloadMcpRuntime() {
  // ACT: Settings saves and the cross-process watch share a serialized
  // reload to avoid racing for the port; the host service is not restarted.
  reloadQueue = reloadQueue.catch(() => {}).then(async () => {
    const current = runtime;
    if (!current) return;
    const preferredPort = getMcpSettings().port;
    if (current.server && current.preferredPort === preferredPort && !current.error) return;
    const server = createServer((req, res) => {
      // Reuse the host protocol and auth, but the fixed port exposes only MCP, not pages or admin APIs.
      if (!/^\/mcp\/?(?:\?|$)/.test(req.url ?? "")) {
        res.writeHead(404).end();
        return;
      }
      current.app(req, res);
    });
    const sockets = new Set<Socket>();
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    let file: string | undefined;
    try {
      // ACT: Multiple instances on one machine try up to 32 adjacent
      // ports; listen directly so the port cannot be taken after probing.
      for (let port = preferredPort; port <= Math.min(preferredPort + 31, 65535); port++) {
        if (port === current.port) {
          current.preferredPort = preferredPort;
          current.error = undefined;
          return;
        }
        try {
          const listening = once(server, "listening");
          server.listen(port, "127.0.0.1");
          await listening;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
          throw error;
        }
        file = resolve(dirname(conf.path), `mcpRuntime${port}.json`);
        const next = { ...current, server, sockets, preferredPort, port, url: `http://127.0.0.1:${port}/mcp`, file, error: undefined };
        saveRuntime(next);
        runtime = next;
        server.unref();
        current.server?.close();
        for (const socket of current.sockets ?? []) socket.destroy();
        removeRuntime(current.file);
        return;
      }
      throw new Error(t`MCP 端口 ${preferredPort}–${Math.min(preferredPort + 31, 65535)} 均已占用，请修改首选端口`);
    } catch (error) {
      server.close();
      removeRuntime(file);
      current.error = `MCP 端口切换失败${current.url ? "，继续使用原地址" : ""}：${error instanceof Error ? error.message : String(error)}`;
      console.error(current.error);
    }
  });
  return reloadQueue;
}

export function getMcpRuntime() {
  const preferredPort = getMcpSettings().port;
  return {
    appOrigin: runtime?.appOrigin,
    endpoint: runtime?.url ?? null,
    preferredPort,
    port: runtime?.port ?? null,
    error: runtime?.error ?? null,
    stdio: runtime?.file && existsSync(runtime.entry)
      ? { command: runtime.command, args: [runtime.entry, "--runtime", runtime.file] }
      : null,
  };
}

conf.onDidChange("settings", (next, previous) => {
  if (JSON.stringify(next?.mcp) === JSON.stringify(previous?.mcp)) return;
  saveRuntime();
  void reloadMcpRuntime().catch(error => console.error("重载 MCP 失败：", error));
});

process.once("exit", () => removeRuntime(runtime?.file));
