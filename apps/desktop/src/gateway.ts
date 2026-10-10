import express from "express";
import { once } from "node:events";
import type { AddressInfo, Socket } from "node:net";
import { initializeMcpRuntime, stopMcpRuntime } from "@toonflow/server/mcp";

/** Serves the app on a random loopback port and rejects requests that do not come from its own page. */
export default async function startGateway(app: express.Express, mcpEntry: string) {
  const gateway = express();
  let origin = "";
  gateway.use((req, res, next) => {
    const localSocket = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    const source = req.get("origin");
    const referer = req.get("referer");
    if (!localSocket || `http://${req.get("host")}` !== origin ||
      source !== undefined && source !== origin || referer !== undefined && !referer.startsWith(`${origin}/`)) {
      return void res.sendStatus(403);
    }
    res.set("Cache-Control", "no-store");
    if (req.method === "GET" && req.path === "/") {
      const target = new URL(req.originalUrl, origin);
      target.searchParams.set("desktop", "1");
      if (`${target.pathname}${target.search}` !== req.originalUrl) return void res.redirect(`${target.pathname}${target.search}`);
    }
    app(req, res, next);
  });
  const server = gateway.listen(0, "127.0.0.1");
  const sockets = new Set<Socket>();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  await initializeMcpRuntime(app, origin, mcpEntry);
  return {
    port,
    async close() {
      await Promise.all([
        new Promise<void>(resolve => {
          server.close(() => resolve());
          // Bun's closeAllConnections does not reliably close SSE, so explicitly release all connections.
          for (const socket of sockets) socket.destroy();
        }),
        stopMcpRuntime(),
      ]);
    },
  };
}
