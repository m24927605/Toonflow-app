import { Router } from "express";
import u from "@/utils";

export default Router().get("/", (req, res) => {
  u.mcpControl.getAppOrigin(req);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write(": connected\n\n");
  let closed = false;
  let reading = false;
  const publish = async () => {
    if (closed || reading) return;
    reading = true;
    try {
      const status = await u.colabPool.readColabPoolStatus();
      if (!closed) res.write(`data: ${JSON.stringify(status)}\n\n`);
    } catch {
      if (!closed) res.write('data: {"unavailable":true}\n\n');
    } finally { reading = false; }
  };
  void publish();
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": keepalive\n\n");
    void publish();
  }, 15000);
  const close = () => {
    closed = true;
    clearInterval(heartbeat);
    res.off("close", close);
    req.socket.off("close", close);
  };
  res.once("close", close);
  req.socket.once("close", close);
});
