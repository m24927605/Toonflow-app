import express from "express";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { mkdir, readFile, readdir, rm, writeAtomic } from "@toonflow/file";
import { getMissingBrowserFeatures } from "@toonflow/web/browserCapabilities";
import { createRemoteConnection } from "@toonflow/server/remoteConnection";
import { languageRequest, translateError, translateMessage } from "@toonflow/server/i18n";
import config from "../../../electrobun.config";

const fromSource = import.meta.path.endsWith(".ts");
const resources = fromSource ? resolve(import.meta.dirname, "../../../build") : import.meta.dirname;
const directory = resolve(process.env.TOONFLOW_MOBILE_DATA_DIR ?? resolve(resources, "mobile/data"));
const exportDirectory = resolve(process.env.TMPDIR ?? resolve(directory, "cache"), "toonflowExports");
const token = randomUUID();
const exportId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const app = express();
let origin = "";

process.env.TOONFLOW_DATA_DIR = directory;
await mkdir(exportDirectory, { recursive: true });
const connection = await createRemoteConnection(directory, { deviceName: process.env.TOONFLOW_MOBILE_DEVICE_NAME || "Toonflow Android", appVersion: config.app.version });
// ACT: Temporary exports are not project data; if the system kills
// the app, unfinished exports are cleaned up on next launch.
for (const entry of await readdir(exportDirectory, { withFileTypes: true })) {
  if (entry.isFile() && exportId.test(entry.name)) await rm(resolve(exportDirectory, entry.name));
}

app.disable("x-powered-by");
app.use(languageRequest);
app.use((request, response, next) => {
  if (`http://${request.get("host")}` !== origin || (request.get("origin") && request.get("origin") !== origin)) {
    response.sendStatus(403);
    return;
  }
  response.setHeader("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("Cache-Control", "no-store");
  // ACT: Exchange a one-time launch credential for a same-origin cookie, covering
  // Axios, SSE, node scripts and media requests without changing each frontend API.
  if (request.method === "GET" && request.path === "/" && request.query.token === token) {
    response.cookie("toonflowMobile", token, { httpOnly: true, sameSite: "strict", path: "/" });
    response.redirect(request.query.probe === "1" ? "/?mobile=1&probe=1"
      : `/?mobile=1${request.query.engine === "x5" ? "&engine=x5" : ""}${connection.remote ? "&remote=1" : ""}`);
    return;
  }
  if (!(request.get("cookie") ?? "").split(";").some(value => value.trim() === `toonflowMobile=${token}`)) {
    response.sendStatus(401);
    return;
  }
  next();
});

app.get("/", (request, response, next) => {
  if (request.query.probe !== "1") {
    if (connection.remote && request.query.remote !== "1") {
      const query = new URLSearchParams(request.originalUrl.split("?")[1]);
      query.set("mobile", "1");
      query.set("remote", "1");
      return void response.redirect(`/?${query}`);
    }
    return next();
  }
  // ACT: Old engines run a small standalone page first so Vue or dependencies do not throw before capability detection.
  // If an old engine cannot parse the detection function, an ES5 baseline
  // result still lets the native shell enter the fallback engine flow.
  response.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Toonflow</title></head><body><script>window.toonflowBrowserProbe={missing:["Browser capability probe"],userAgent:navigator.userAgent};</script><script>window.toonflowBrowserProbe={missing:(${getMissingBrowserFeatures.toString()})(),userAgent:navigator.userAgent};</script></body></html>`);
});

app.get("/api/mobile/runtime", (_request, response) => {
  response.json({ bun: Bun.version, platform: process.platform, arch: process.arch });
});
app.post("/api/mobile/exports", express.raw({ type: "application/octet-stream", limit: "100mb" }), async (request, response) => {
  if (!Buffer.isBuffer(request.body)) {
    response.status(400).json({ message: translateMessage("导出内容必须是文件数据") });
    return;
  }
  const id = randomUUID();
  const path = resolve(exportDirectory, id);
  await writeAtomic(path, request.body, { mode: 0o600 });
  // ACT: Reuse the existing file API's 100 MB limit; larger exports need streamed staging.
  setTimeout(() => { void rm(path, { force: true }).catch(console.error); }, 30 * 60 * 1000).unref();
  response.json({ url: `/api/mobile/exports/${id}` });
});
app.route("/api/mobile/exports/:id")
  .all((request, response, next) => {
    if (!exportId.test(request.params.id)) return void response.sendStatus(400);
    next();
  })
  .get((request, response, next) => {
    response.type("application/octet-stream").sendFile(resolve(exportDirectory, request.params.id), error => {
      if (error) next(error);
    });
  })
  .delete(async (request, response) => {
    await rm(resolve(exportDirectory, request.params.id), { force: true });
    response.sendStatus(204);
  });
app.use("/api/connection", connection.router);

let toonflow: express.Express | undefined;
if (connection.proxy) {
  app.use(connection.proxy);
} else {
  const { createApp } = await import("@toonflow/server/app");
  toonflow = await createApp({
    webRoot: resolve(resources, "web"),
    appVersion: config.app.version,
    dataDirectory: directory,
    toolsRoot: resolve(resources, "tools"),
    nodesRoot: resolve(resources, "nodes"),
    extRoot: resolve(resources, "ext"),
    providersRoot: resolve(resources, "providers"),
    skillsRoot: resolve(resources, "skills"),
    pluginRevision: fromSource ? undefined : (await readFile(resolve(resources, "revision.txt"), "utf8")).trim(),
  });
  app.use(toonflow);
}
app.use((error: Error & { status?: number }, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (response.headersSent) return next(error);
  console.error(error);
  response.status(error.status ?? 500).json({ message: translateError(error) });
});

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法获取本地服务端口");
origin = `http://127.0.0.1:${address.port}`;
if (toonflow) {
  const { initializeMcpRuntime } = await import("@toonflow/server/mcp");
  await initializeMcpRuntime(toonflow, origin, resolve(resources, "mcp/stdio.js"), undefined, { Cookie: `toonflowMobile=${token}` });
}
console.log(`TOONFLOW_MOBILE_URL=${origin}/?token=${token}`);
server.on("error", error => { console.error(error); process.exit(1); });
process.on("SIGTERM", () => { connection.stop(); server.close(() => process.exit(0)); });
