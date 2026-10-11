import { msg } from "@toonflow/i18n";
import { messageError } from "@toonflow/i18n/errors";
import { chainMethods, queryMethods, runMethods } from "./browserTypes";
import type { BrowserFfmpegRequest, FfmpegCall, FfmpegRemoteEvent } from "./browserTypes";
import type { FfmpegCommand, FfmpegFactory } from "./types";

export { chainMethods, queryMethods, runMethods } from "./browserTypes";

const chainNames = new Set<string>(chainMethods);
const queryNames = new Set<string>(queryMethods);
const runNames = new Set<string>(runMethods);
const inputNames = new Set(["input", "addInput", "mergeAdd"]);
const outputNames = new Set(["output", "addOutput", "save", "saveToFile", "concat", "concatenate", "mergeToFile"]);

function serializeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, ...("code" in error ? { code: error.code } : {}), ...("i18nMessage" in error ? { i18nMessage: error.i18nMessage } : {}) }
    : { name: "Error", message: String(error) };
}

function invoke(command: FfmpegCommand, call: FfmpegCall, extra: unknown[] = []) {
  if ((inputNames.has(call.method) || outputNames.has(call.method)) && typeof call.args[0] !== "string") {
    throw new Error("Browser FFmpeg input and output must use the workspace file path");
  }
  const args = call.args.map((value, index) => call.undefinedArgs?.includes(index) ? undefined : value);
  return Reflect.apply((command as unknown as Record<string, (...args: unknown[]) => unknown>)[call.method]!, command, [...args, ...extra]);
}

/**
 * The browser only sends chained-call data; execution and explicit path checks still use the native workspace factory.
 */
export async function executeRemoteFfmpeg(
  factory: FfmpegFactory,
  request: BrowserFfmpegRequest,
  emit: (event: FfmpegRemoteEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted();
    for (const call of request.calls) {
      if (!chainNames.has(call.method)) throw messageError(msg`FFmpeg configuration method is not available: ${call.method}`);
    }
    const operation = request.operation;
    if (!queryNames.has(operation.method) && !runNames.has(operation.method)) {
      throw messageError(msg`FFmpeg execution method is not available: ${operation.method}`);
    }
    let command = factory(request.options);
    for (const call of request.calls) command = invoke(command, call) as FfmpegCommand;
    await new Promise<void>(resolve => {
      let finished = false;
      const send = (event: string, args: unknown[]) => { if (!finished) emit({ event, args }); };
      const finish = (event: string, args: unknown[]) => {
        if (finished) return;
        if (signal.aborted) {
          event = "error";
          args = [serializeError(signal.reason ?? new DOMException("FFmpeg Canceled", "AbortError"))];
        }
        send(event, args);
        finished = true;
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const fail = (error: unknown, ...args: unknown[]) => finish("error", [serializeError(error), ...args]);
      const cancel = () => {
        // ACT: kill only sends a signal;
        // return after the native completion event so the caller can safely clean up output files.
        if (!queryNames.has(operation.method)) command.kill("SIGKILL");
      };
      signal.addEventListener("abort", cancel, { once: true });
      // ACT: Cancellation may precede spawn;
      // keep listening, terminate right after the preparation phase, and catch late errors.
      command.on("start", (...args) => {
        if (signal.aborted) command.kill("SIGKILL");
        else send("start", args);
      });
      command.on("error", fail);
      command.on("end", (...args) => finish("end", args));
      for (const event of ["progress", "stderr", "codecData", "filenames"] as const) {
        command.addListener(event, (...args: unknown[]) => send(event, args));
      }
      try {
        signal.throwIfAborted();
        if (queryNames.has(operation.method)) {
          // ACT: fluent does not expose the query child process;
          // after cancelling, wait for the query callback to release files, not for a start that queries never emit.
          invoke(command, operation, [(error: unknown, data: unknown) => error ? fail(error) : finish("result", [data])]);
        } else {
          invoke(command, operation);
        }
      } catch (error) {
        fail(error);
      }
    });
  } catch (error) {
    emit({ event: "error", args: [serializeError(error)] });
  }
}
