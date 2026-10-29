import logger from "morgan";
import express from "express";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFile, readdir } from "@toonflow/file";
import type { Request, Response, NextFunction } from "express";
import buildRoute from "@/core";
import { errorFromCause } from "@/lib/responseFormat";
import initializePlugins, { syncEditablePlugins } from "@/utils/plugins/initialize";
import { languageRequest, resolveRequestLocale, runWithLocale, setLocaleFallback, translateError, translateMessage } from "@/lib/i18n";
import { detectLocale, normalizeLocale } from "@toonflow/i18n";

const autoInstallProviders = ["openai.ts", "higgsfield.ts", "gemini.ts", "fishAudio.ts", "metaso.ts", "sulphur.ts", "qwenImage.ts", "suno.ts"];

/** Hashes the given files so built-in plugins sync once per build, including upgrades that keep the data directory. */
async function contentRevision(files: string[]) {
  const hash = createHash("sha256");
  for (const file of files) {
    const source = await readFile(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    hash.update(basename(file)).update("\0").update(source).update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(directory?: string) {
  if (!directory) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter(entry => entry.isFile()).map(entry => resolve(directory, entry.name)).sort();
}

export async function createApp({
  webRoot,
  appVersion = "",
  dataDirectory,
  toolsRoot,
  nodesRoot,
  extRoot,
  providersRoot,
  skillsRoot,
  agentsRoot,
}: {
  webRoot: string;
  appVersion?: string;
  dataDirectory?: string;
  toolsRoot?: string;
  nodesRoot?: string;
  extRoot?: string;
  providersRoot?: string;
  skillsRoot?: string;
  agentsRoot?: string;
}) {
  // conf is loaded dynamically by the routes below, so the process-wide data directory must be set first.
  if (dataDirectory) process.env.TOONFLOW_DATA_DIR = resolve(dataDirectory);
  const { default: conf } = await import("@/utils/conf");
  setLocaleFallback(() => normalizeLocale((conf.get("settings", {}).ui as { language?: unknown } | undefined)?.language)
    ?? detectLocale([Intl.DateTimeFormat().resolvedOptions().locale]));
  const pluginRevision = dataDirectory ? await contentRevision([...await listFiles(toolsRoot), ...await listFiles(nodesRoot), ...await listFiles(extRoot)]) : undefined;
  if (dataDirectory && toolsRoot)
    await initializePlugins(resolve(dataDirectory, "tools"), toolsRoot, /^[a-z][a-zA-Z0-9]*\.tool\.js$/, pluginRevision);
  if (dataDirectory && nodesRoot) await initializePlugins(resolve(dataDirectory, "nodes"), nodesRoot, /^[a-z][a-zA-Z0-9]*\.umd\.js$/, pluginRevision);
  if (dataDirectory && extRoot) {
    const { default: initializeExt } = await import("@/utils/plugins/initializeExt");
    await initializeExt(resolve(dataDirectory, "ext"), extRoot, pluginRevision);
  }
  // ACT: Built-in media providers sync with the build; other provider files and separately saved configs are kept.
  if (dataDirectory && providersRoot) {
    const sourceDirectory = resolve(providersRoot, "media");
    const providerRevision = await contentRevision(autoInstallProviders.map(name => resolve(sourceDirectory, name)));
    await initializePlugins(resolve(dataDirectory, "providers"), sourceDirectory, autoInstallProviders, providerRevision);
  }
  // Built-in skills follow the build unless they were edited; teams are only installed on first run, preserving edits.
  if (dataDirectory && skillsRoot) await syncEditablePlugins(resolve(dataDirectory, "skills"), skillsRoot);
  if (dataDirectory && agentsRoot) await initializePlugins(resolve(dataDirectory, "agents"), agentsRoot);
  const app = express();
  app.locals.appVersion = appVersion;

  if (process.env.NODE_ENV === "dev") {
    await buildRoute();
    app.use(logger("dev"));
  }
  const { getAppOrigin } = await import("@/utils/mcp/control");
  const { isLocalClient } = await import("@/utils/workspace");
  // Local mode serves this computer only, for every request: the Origin check below runs only when a page sends one.
  if (process.env.NODE_ENV === "dev" && ["win32", "darwin"].includes(process.platform)) app.use((req, _res, next) => {
    if (!isLocalClient(req)) throw Object.assign(new Error("Local Toonflow only opens on this computer, at localhost or 127.0.0.1"), { status: 403 });
    next();
  });
  app.use("/api", (req, _res, next) => {
    if (req.get("origin") || req.get("referer") || !["GET", "HEAD"].includes(req.method)) getAppOrigin(req);
    next();
  });
  app.use(languageRequest);
  app.use("/a2a", express.json({ limit: "2mb" }));
  app.use(["/api/workspaces/files/write", "/api/assets/save"], express.raw({ type: "application/octet-stream", limit: "100mb" }));
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  const router = await import("@/router");
  router.default(app);
  const [{ createMcpRouter }, { getMcpTools }, { authorizeMcp }, { skillResources }] = await Promise.all([
    import("@toonflow/mcp"),
    import("@/utils/mcp/tools"),
    import("@/utils/mcp/control"),
    import("@/utils/mcp/resources"),
  ]);
  app.use("/mcp", createMcpRouter({ getTools: getMcpTools, authorize: authorizeMcp, resources: skillResources,
    runInRequest: (request, operation) => runWithLocale(resolveRequestLocale(request.get("accept-language")), operation),
    translate: translateMessage,
    translateError,
  }));
  const { claudeCodeToolsRouter } = await import("@/utils/ai/claudeCode");
  app.use("/claudeCode/mcp", claudeCodeToolsRouter);
  const { createA2aRouter } = await import("@/agent/a2a");
  app.use("/a2a", createA2aRouter());
  app.use(express.static(webRoot));

  // Error handling
  app.use((err: Error & { status?: number }, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(err);
    console.error(err);
    const body = errorFromCause(err);
    response.status(body.code).json(body);
  });
  return app;
}
