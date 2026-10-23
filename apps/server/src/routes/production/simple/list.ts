import { Router } from "express";
import { readdir } from "@toonflow/file";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, await u.production.simpleWorkspaceDirectory());
  const { path } = await u.workspaceFile.resolveWorkspacePath(cwd, "productions", true);
  const entries = await readdir(path, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return [];
    throw cause;
  });
  const productions = await Promise.all(entries.filter(entry => entry.isDirectory() && /^[A-Za-z0-9-]{1,64}$/.test(entry.name)).map(async entry => {
    const production = await u.production.readProduction(cwd, entry.name).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (!production) {
      const conversation = await u.production.getProductionConversation(cwd, entry.name);
      const first = conversation.turns[0];
      if (!first) return undefined;
      return { id: entry.name, outline: first.message, createdAt: first.at, status: "chatting" as const, hasProduction: false, fromConversation: true, clarifications: [], progress: { active: false, finished: false, cleanupStatus: "unknown" as const, elapsedSeconds: 0, totalShots: 0, completedShots: 0, phases: [] } };
    }
    if (production.input.mode !== "simple") return undefined;
    return {
      hasProduction: true, fromConversation: production.input.fromConversation === true,
      id: production.id, outline: production.originalOutline ?? production.input.outline, createdAt: production.createdAt,
      clarifications: production.recoveries?.flatMap(item => item.action === "clarify" && item.message ? [{ at: item.at, message: item.message }] : []) ?? [],
      status: production.status, message: production.message, detail: production.detail,
      film: production.status === "done" ? production.film : undefined,
      stage: production.timings?.findLast(item => !item.end)?.step ?? production.timings?.at(-1)?.step,
      progress: u.production.productionProgress(production, u.production.isProductionRunning(cwd, production.id)),
      guidance: u.production.productionGuidance(production),
    };
  }));
  res.set("Cache-Control", "no-store").json(success({ directory: cwd, productions: productions.filter(item => !!item).sort((left, right) => left.createdAt.localeCompare(right.createdAt)) }));
});
