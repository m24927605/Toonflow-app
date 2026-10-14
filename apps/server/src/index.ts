import { resolve } from "node:path";
import { createApp } from "./app";
import { stopOrphanedColabSessions } from "./utils/media/colab";
import { resumeRunningProductions } from "./utils/production";
import packageInfo from "../../../package.json";

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
// A Colab A100 left running by a killed server keeps billing, so clear those sessions before taking new jobs; then
// the productions that were running continue from their last saved step.
stopOrphanedColabSessions().then(
  sessions => sessions.length && console.log(`[colab] Stopped orphaned sessions: ${sessions.join(", ")}`),
  error => console.error("[colab] Orphaned session cleanup failed; check with `colab sessions`:", error),
).then(resumeRunningProductions).catch(error => console.error("[production] Resuming productions failed:", error));
const { initializeMcpRuntime } = await import("./utils/mcp/runtime");
app.listen(realPort, async () => {
  await initializeMcpRuntime(app, `http://127.0.0.1:${realPort}`, resolve(appDirectory, fromSource ? "packages/mcp/src/stdio.ts" : "build/mcp/stdio.js"));
  console.log(`[Server started]: http://localhost:${realPort}`);
  console.log(`[Startup time]: ${(Date.now() - startTime).toFixed(2)}ms`);
});
