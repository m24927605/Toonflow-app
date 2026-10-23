import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), request: u.mediaSnapshots.snapshotRequestSchema }), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const request = u.mediaSnapshots.snapshotRequestSchema.parse(req.body.request);
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on("close", abort);
  try {
    const snapshot = await u.mediaSnapshots.snapshotMedia(cwd, request, AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]));
    res.json(success(snapshot));
  } finally {
    res.off("close", abort);
  }
});
