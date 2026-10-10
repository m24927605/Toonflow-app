import { parentPort, workerData } from "node:worker_threads";
import { showWindowsSplash } from "./windowsSplash";

if (!parentPort || typeof workerData !== "string") throw new Error("启动动画必须在工作线程中运行。");
const port = parentPort;
const splash = showWindowsSplash(workerData, () => {
  port.postMessage("cancelled");
  close();
});

function close() {
  splash.close();
  // Bun's message listener keeps the thread alive; remove it before closing the port so the thread can exit naturally.
  port.off("message", onMessage);
  port.close();
}

function onMessage(command: "finish" | "close") {
  if (command === "finish") {
    void splash.finish().then(() => port.postMessage("finished"));
  } else if (command === "close") {
    close();
  }
}
port.on("message", onMessage);
// Before exiting naturally, free Win32/GDI/animation resources on the thread that created the window,
// without force-terminating the Worker.
process.on("exit", () => splash.close());
port.postMessage("ready");
