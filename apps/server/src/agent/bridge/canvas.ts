import { canvasOperations } from "@toonflow/tool-canvas/runtime";
import type { CanvasInfo, CanvasContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";

type CanvasResult = { result?: unknown; error?: string };
type PendingCall = { cwd: string; finish(response: CanvasResult): void };

// ACT: Callbacks are only valid while the current server process is
// alive; multi-process deployments need a shared request channel.
const pendingCalls = new Map<string, PendingCall>();

export function createCanvasContext(cwd: string, canvas: CanvasInfo, send: (event: Extract<AgentEvent, { type: "canvasCall" }>) => void) {
  const activeCalls = new Set<string>();
  let queue = Promise.resolve();
  let disposed = false;
  const context: CanvasContext = {
    ...canvas,
    async call(request, signal) {
      // The frontend applies canvas changes sequentially; send and start timing
      // only on this call's turn so queueing does not eat the execution timeout.
      const pending = queue.then(() => {
        if (disposed) throw new Error("The conversation to which the canvas call belongs has ended");
        signal?.throwIfAborted();
        const operation = canvasOperations.find(item => item.name === request.name);
        if (!operation) throw new Error("Canvas operation does not exist");
        const args = operation.parameters.parse(request.args);
        const callId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          const finish = ({ result, error }: CanvasResult) => {
            if (!pendingCalls.delete(callId)) return;
            activeCalls.delete(callId);
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error !== undefined) reject(new Error(error || "Canvas call failed"));
            else resolve(result);
          };
          const abort = () => finish({ error: "Canvas call canceled" });
          const timer = setTimeout(() => finish({ error: "The canvas call timed out, please confirm that the canvas is still open" }), 120000);
          pendingCalls.set(callId, { cwd, finish });
          activeCalls.add(callId);
          signal?.addEventListener("abort", abort, { once: true });
          try { send({ type: "canvasCall", callId, name: operation.name, args }); }
          catch (error) { finish({ error: (error instanceof Error ? error.message : "") || "Send canvas call failed" }); }
        });
      });
      queue = pending.then(() => {}, () => {});
      return pending;
    },
  };
  return {
    context,
    dispose() {
      disposed = true;
      for (const callId of activeCalls) pendingCalls.get(callId)?.finish({ error: "The conversation to which the canvas call belongs has ended" });
    },
  };
}

export function finishCanvasCall(cwd: string, callId: string, response: CanvasResult) {
  const pending = pendingCalls.get(callId);
  // Callbacks may still arrive after timeout, cancellation or completion;
  // ignore them idempotently to avoid aborting the whole turn.
  if (!pending) return;
  if (pending.cwd !== cwd) throw Object.assign(new Error("Canvas call does not exist or has ended"), { status: 404 });
  pending.finish(response);
}
