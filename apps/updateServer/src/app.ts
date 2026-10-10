import express from "express";
import type { Request, Response, NextFunction } from "express";
import { lstatSync, withFileAccess } from "@toonflow/file";
import { join, resolve } from "node:path";
import { error } from "@/lib/responseFormat";

export function createApp(publicDirectory: string) {
  const app = express();
  const publicDir = resolve(publicDirectory);
  app.set("case sensitive routing", true);
  app.disable("x-powered-by");
  app.disable("etag");

  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.set("Allow", "GET, HEAD").status(405).end();
      return;
    }
    const name = req.path.slice(1);
    const filePath = join(publicDir, name);
    // ACT: Only serve flat ASCII file names produced by the publisher; do not decode URLs or follow symlinks.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || !lstatSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      res.status(404).end();
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    // A disconnect before headers are sent only fires the request's
    // aborted in Bun, so listening for response close alone is not enough.
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      await withFileAccess([filePath], "read", () => new Promise<void>((resolve, reject) => {
        if (req.aborted || res.destroyed) return resolve();
        res.sendFile(filePath, { cacheControl: false, lastModified: false, etag: false }, err => err ? reject(err) : resolve());
      }), controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && !req.aborted && !res.destroyed) throw error;
    } finally {
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
  });

  app.use((err: Error & { status?: number; code?: string }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = err.status ?? (err.code === "ENOENT" ? 404 : 500);
    const message = status >= 500 ? "服务器内部错误" : err.message;
    res.status(status).json(error(message, null, status));
  });
  return app;
}
