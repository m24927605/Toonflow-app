import { resolve } from "node:path";
import { createApp } from "./app";
import packageInfo from "../../../package.json";
import { scheduler } from "node:timers/promises";

const startTime = Date.now();
const realPort = 3000;
// Source lives in apps/server/src and the production build in build/server; both locate the root from the file location.
const fromSource = import.meta.path.endsWith(".ts");
const appDirectory = resolve(import.meta.dirname, fromSource ? "../../.." : "../..");
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(appDirectory, "data");
const app = await createApp({
  webRoot: resolve(appDirectory, "build/web"),
  appVersion: packageInfo.version,
  dataDirectory,
  toolsRoot: resolve(appDirectory, "build/tools"),
  nodesRoot: resolve(appDirectory, "build/nodes"),
  extRoot: resolve(appDirectory, "build/ext"),
  // ACT: Built-in teams are not installed for now; restore together with team bundling.
  // agentsRoot: resolve(appDirectory, "build/agents"),
  providersRoot: resolve(appDirectory, fromSource ? "packages/providers/src" : "build/providers"),
  skillsRoot: resolve(appDirectory, fromSource ? "packages/skills" : "build/skills"),
});
const { resumeRunningProductions, productionWorkPending } = await import("./utils/production");
const { mediaWorkPending } = await import("./utils/media/jobs");
const { restoreColabPool, checkpointColabPool, colabPoolIdle } = await import("./utils/media/colabPool");
restoreColabPool(new AbortController().signal).then(resumeRunningProductions).catch(error => console.error("[colab] Existing machines could not be reconnected; no replacement was allocated:", error));
let restarting = false;
const restart = async () => {
  if (restarting) return;
  restarting = true;
  while (productionWorkPending() || mediaWorkPending() || !colabPoolIdle()) await scheduler.wait(250);
  await checkpointColabPool();
  process.exit(0);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR1"] as const) process.on(signal, () => { void restart().catch(error => { restarting = false; console.error("[server] Could not checkpoint before restart:", error); }); });
const { initializeMcpRuntime } = await import("./utils/mcp/runtime");
app.listen(realPort, async () => {
  // Auto production opens its headless previs page here.
  process.env.TOONFLOW_APP_ORIGIN = `http://localhost:${realPort}`;
  await initializeMcpRuntime(app, `http://127.0.0.1:${realPort}`, resolve(appDirectory, fromSource ? "packages/mcp/src/stdio.ts" : "build/mcp/stdio.js"));
  console.log(`[Server started]: http://localhost:${realPort}`);
  console.log(`[Startup time]: ${(Date.now() - startTime).toFixed(2)}ms`);
});
