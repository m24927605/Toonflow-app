import { createBrowserRuntime } from "@toonflow/tool-browser/host";
import type { ToolContext } from "@toonflow/tools-scaffold/runtime";

export const browserRuntime = createBrowserRuntime();

export function createBrowserContext(cwd: string): ToolContext["browser"] {
  // The browser tool drives a local Chrome or Edge, so it only runs in local development.
  if (process.env.NODE_ENV !== "dev") return;
  return { execute: (sessionId, args, config, signal, onUpdate) => browserRuntime.execute(cwd, sessionId, args, config, signal, onUpdate) };
}

