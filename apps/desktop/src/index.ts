import { setLocaleFallback, t, translateMessage } from "@toonflow/server/i18n";
import { detectLocale, normalizeLocale } from "@toonflow/i18n";
import { execFile } from "node:child_process";
import { existsSync, writeAtomicSync } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { dlopen, ptr } from "bun:ffi";
import type { DesktopRuntime, PluginInstallRequest } from "@toonflow/server/desktop";
import { showNativeSplash } from "@toonflow/startup";
import Electrobun, { ApplicationMenu, BrowserWindow, PATHS, Screen, Utils, Updater } from "electrobun/main";
import { parseInstallUrl } from "./protocol";
import saveFile, { selectSaveFile } from "./saveFile";
import createWindowsUpdater, { confirmWindowsUpdateStartup } from "./update/windowsUpdater";

const execFileAsync = promisify(execFile);
const pendingInstalls: PluginInstallRequest[] = [];
let deliverInstall: ((request: PluginInstallRequest) => void) | undefined;
function openUrl(url: string) {
  const request = parseInstallUrl(url);
  if (deliverInstall) deliverInstall(request);
  else if (!pendingInstalls.some(item => item.type === request.type && item.url === request.url)) {
    if (pendingInstalls.length >= 20) throw new Error(t`待确认的安装请求过多，请稍后重试`);
    pendingInstalls.push(request);
  }
}
// On a macOS cold start the URL may arrive before the window is ready; accept it first, then wait for the page to mount.
Electrobun.events.on("open-url", event => {
  try { openUrl(event.data.url); }
  catch (error) {
    void Utils.showMessageBox({ type: "error", title: t`安装链接无效`, message: translateMessage(error instanceof Error ? error.message : "无法打开安装链接") });
  }
});

async function restoreInstallRegistration(installDirectory: string) {
  const uninstaller = resolve(installDirectory, "UninstallNSIS.exe");
  if (process.platform === "win32" && existsSync(uninstaller)) {
    try {
      // SDK launches and updates rewrite the uninstall entry; when
      // installed via NSIS, let it handle the data retention option.
      const { identifier, channel } = await file(resolve(PATHS.RESOURCES_FOLDER, "version.json")).json();
      const registryKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identifier}.${channel}`;
      for (const [name, command] of [["UninstallString", `"${uninstaller}"`], ["QuietUninstallString", `"${uninstaller}" /S`]]) {
        await execFileAsync("reg.exe", ["add", registryKey, "/v", name, "/t", "REG_SZ", "/d", command, "/f"], { windowsHide: true });
      }
      const protocolLauncher = resolve(PATHS.RESOURCES_FOLDER, "app/protocolLauncher.exe");
      if (existsSync(protocolLauncher)) {
        const protocolKey = "HKCU\\Software\\Classes\\toonflow";
        const commandKey = `${protocolKey}\\shell\\open\\command`;
        const command = `"${protocolLauncher}" "%1"`;
        let protocolExists = true;
        try {
          await execFileAsync("reg.exe", ["query", protocolKey], { windowsHide: true });
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
          protocolExists = false;
        }
        // ACT: Auto-updates bypass NSIS; only register a missing protocol and
        // leave existing registrations (including other installs) untouched.
        if (!protocolExists) {
          for (const [key, value] of [[protocolKey, "URL:Toonflow Protocol"], [`${protocolKey}\\DefaultIcon`, `"${resolve(PATHS.RESOURCES_FOLDER, "app.ico")}",0`], [commandKey, command]]) {
            await execFileAsync("reg.exe", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true });
          }
          await execFileAsync("reg.exe", ["add", protocolKey, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"], { windowsHide: true });
        }
      }
    } catch (error) {
      console.error("恢复桌面安装注册信息失败：", error);
    }
  }
}

async function start() {
  let splash: Awaited<ReturnType<typeof showNativeSplash>> | undefined;
  let desktopConnection: Awaited<ReturnType<typeof import("./connection").default>> | undefined;
  let isClosing = false;

  try {
    // On Windows data sits next to app; on macOS data sits next to the .app, so app updates do not replace it.
    const installDirectory = resolve(PATHS.RESOURCES_FOLDER, process.platform === "darwin" ? "../../.." : "../..");
    const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(installDirectory, "data");
    // ACT: Show the native animation before loading the server so there is feedback during initialization.
    const startupSettings = await file(resolve(dataDirectory, "settings.json")).json().catch((error) => {
      if (error.code !== "ENOENT") console.error("读取启动设置失败，使用默认启动动画：", error);
      return null;
    });
    setLocaleFallback(() => normalizeLocale(startupSettings?.settings?.ui?.language)
      ?? detectLocale([Intl.DateTimeFormat().resolvedOptions().locale]));
    if (process.platform === "darwin") {
      // ACT: WKWebView Command editing shortcuts are routed to the current responder via native menu roles.
      ApplicationMenu.setApplicationMenu([
        { label: "Toonflow", submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "showAll" },
          { type: "separator" },
          { role: "quit" },
        ] },
        { label: t`编辑`, submenu: [
          { role: "undo", label: t`撤销` },
          { role: "redo", label: t`重做` },
          { type: "separator" },
          { role: "cut", label: t`剪切` },
          { role: "copy", label: t`复制` },
          { role: "paste", label: t`粘贴` },
          { role: "selectAll", label: t`全选` },
        ] },
      ]);
    }
    try {
      if (startupSettings?.settings?.ui?.startupAnimation !== false) {
        splash = await showNativeSplash(resolve(PATHS.VIEWS_FOLDER, "../startup"), () => {
          isClosing = true;
          splash = undefined;
          Utils.quit();
        });
      }
    } catch (error) {
      console.error("原生启动画面创建失败：", error);
    }
    if (isClosing) {
      splash?.close();
      return;
    }
    process.env.toonflowDesktop = "1";
    const { createApp } = await import("@toonflow/server/app");
    const { closeBrowsers } = await import("@toonflow/server/browser");
    const { hash, version } = await file(resolve(PATHS.RESOURCES_FOLDER, "version.json")).json();
    if (typeof hash !== "string" || !hash) throw new Error(t`应用构建标识缺失，无法同步内置插件`);
    const app = await createApp({
      webRoot: resolve(PATHS.VIEWS_FOLDER, "mainview"),
      appVersion: typeof version === "string" ? version : "",
      dataDirectory,
      toolsRoot: resolve(PATHS.VIEWS_FOLDER, "../tools"),
      nodesRoot: resolve(PATHS.VIEWS_FOLDER, "../nodes"),
      extRoot: resolve(PATHS.VIEWS_FOLDER, "../ext"),
      providersRoot: resolve(PATHS.VIEWS_FOLDER, "../providers"),
      skillsRoot: resolve(PATHS.VIEWS_FOLDER, "../skills"),
      // ACT: Built-in teams are not installed for now; restore together with team bundling.
      // agentsRoot: resolve(PATHS.VIEWS_FOLDER, "../agents"),
      pluginRevision: hash,
    });
    const { default: createDesktopConnection } = await import("./connection");
    const connection = desktopConnection = await createDesktopConnection(app, dataDirectory, resolve(PATHS.VIEWS_FOLDER, "../mcp/stdio.js"), (port, remote) => {
      deliverInstall = undefined;
      saveRuntime(port);
      mainWindow.webview.loadURL(`http://127.0.0.1:${port}/?desktop=1${remote ? "&remote=1" : ""}`);
    }, error => {
      console.error("设备连接切换失败：", error);
      void Utils.showMessageBox({ type: "error", title: t`设备连接失败`, message: error instanceof Error ? error.message : String(error) });
    });
    if (isClosing) { await connection.close(); return; }
    console.log(`桌面服务：http://127.0.0.1:${connection.port}`);

    const { workArea } = Screen.getPrimaryDisplay();
    // ACT: Clamp width and height separately to the screen's usable area,
    // leaving room for the title bar and margins, with no fixed aspect ratio.
    const width = Math.min(1280, workArea.width - 64);
    const height = Math.min(960, workArea.height - 64);
    const mainWindow = new BrowserWindow({
      title: "Toonflow",
      url: `http://127.0.0.1:${connection.port}/?desktop=1${connection.remote ? "&remote=1" : ""}`,
      hidden: Boolean(splash),
      frame: {
        width,
        height,
        x: workArea.x + Math.round((workArea.width - width) / 2),
        y: workArea.y + Math.round((workArea.height - height) / 2),
      },
    });
    // ACT: Global events in both SDK versions carry no WebView ID, so an event-name suffix scopes them to the main window.
    Electrobun.events.on(`new-window-open-${mainWindow.webview.id}`, (event: { data: { detail: unknown } }) => {
      const detail = event.data.detail;
      const url = typeof detail === "string" ? detail : detail && typeof detail === "object" && "url" in detail ? detail.url : undefined;
      if (typeof url !== "string" || !URL.canParse(url)) return;
      const target = new URL(url);
      if (target.protocol !== "http:" && target.protocol !== "https:") return;
      if (!Utils.openExternal(target.href)) {
        void Utils.showMessageBox({ type: "error", title: t`打开链接失败`, message: t`请检查默认浏览器设置后重试。` });
      }
    });
    // Listeners are destroyed with the old page on reload, so install requests are delivered once the new page is ready.
    Electrobun.events.on(`will-navigate-${mainWindow.webview.id}`, () => { deliverInstall = undefined; });
    let isShowing = false;
    app.locals.desktop = {
      openUrl,
      showItemInFolder: Utils.showItemInFolder,
      readClipboardText: Utils.clipboardReadText,
      readClipboardImage: Utils.clipboardReadImage,
      writeClipboardImage: Utils.clipboardWriteImage,
      writeClipboardText: Utils.clipboardWriteText,
      selectSaveFile,
      saveFile,
      async selectProviderFile() {
        const [path] = await Utils.openFileDialog({ allowedFileTypes: "ts", canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false });
        return path ?? null;
      },
      async selectDirectory() {
        const [path] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
        return path ?? null;
      },
      async ready(failed = false) {
        if (isClosing) return;
        if (!isShowing) {
          if (splash) {
            await splash.finish();
            if (isClosing || !splash) return;
            mainWindow.show();
            splash.close();
            splash = undefined;
          }
          isShowing = true;
          // ACT: The installer has completed registration; the post-update
          // repair runs only on first show and does not block the main window.
          void restoreInstallRegistration(installDirectory);
        }
        if (failed && !connection.remote) {
          if (process.platform === "win32") confirmWindowsUpdateStartup(PATHS.RESOURCES_FOLDER, true);
          else await (Updater as DesktopRuntime["updater"]).confirmStartup?.(true);
          deliverInstall = undefined;
          return;
        }
        if (connection.remote) {
          // An offline remote does not mean the local update launch failed;
          // install protocol requests are delivered after returning to standalone.
          deliverInstall = undefined;
          if (process.platform === "win32") confirmWindowsUpdateStartup(PATHS.RESOURCES_FOLDER);
          else await (Updater as DesktopRuntime["updater"]).confirmStartup?.();
          return;
        }
        deliverInstall = request => {
          mainWindow.unminimize();
          mainWindow.show();
          mainWindow.activate();
          mainWindow.webview.executeJavascript(`window.dispatchEvent(new CustomEvent("toonflow:install-plugin", { detail: ${JSON.stringify(request)} }));`);
        };
        while (pendingInstalls.length) {
          deliverInstall(pendingInstalls[0]!);
          pendingInstalls.shift();
        }
        if (process.platform === "win32") confirmWindowsUpdateStartup(PATHS.RESOURCES_FOLDER);
        else await (Updater as DesktopRuntime["updater"]).confirmStartup?.();
      },
      openDevTools() { mainWindow.webview.openDevTools(); },
      // ACT: Windows uses a two-phase exit; Intel Mac adapts the 1.18.1 updater through a compatibility entry.
      updater: process.platform === "win32" ? createWindowsUpdater(PATHS.RESOURCES_FOLDER, Utils as unknown as Parameters<typeof createWindowsUpdater>[1]) : Updater,
    } satisfies DesktopRuntime;
    if (process.platform === "win32") {
      // ACT: Electrobun 2.0.1 does not set the Windows window icon, so reuse the app ICO from the build output.
      const user32 = dlopen("user32.dll", {
        LoadImageW: { args: ["ptr", "ptr", "u32", "i32", "i32", "u32"], returns: "ptr" },
        SendMessageW: { args: ["ptr", "u32", "u64", "ptr"], returns: "ptr" },
        GetDpiForWindow: { args: ["ptr"], returns: "u32" },
        GetSystemMetricsForDpi: { args: ["i32", "u32"], returns: "i32" },
        DestroyIcon: { args: ["ptr"], returns: "i32" },
      });
      const native = user32.symbols;
      const window = mainWindow.ptr;
      const dpi = native.GetDpiForWindow(window);
      const iconPath = Buffer.from(`${resolve(PATHS.RESOURCES_FOLDER, "app.ico")}\0`, "utf16le");
      // ICON_SMALL / ICON_BIG, each using the system size for the current window DPI.
      const icons = [49, 11].map((metric) => native.LoadImageW(
        null, ptr(iconPath), 1, native.GetSystemMetricsForDpi(metric, dpi), native.GetSystemMetricsForDpi(metric + 1, dpi), 0x10,
      ));
      const closeIcons = () => {
        for (const icon of icons) if (icon) native.DestroyIcon(icon);
        user32.close();
      };
      if (icons.some((icon) => !icon)) {
        closeIcons();
        throw new Error(t`无法加载主窗口图标`);
      }
      icons.forEach((icon, type) => native.SendMessageW(window, 0x80, type, icon));
      mainWindow.on("close", closeIcons);
    }
    mainWindow.on("close", () => {
      void connection.close().catch(error => console.error("设备连接关闭失败：", error));
      void closeBrowsers().catch(error => console.error("浏览器关闭失败：", error));
      isClosing = true;
      deliverInstall = undefined;
      pendingInstalls.length = 0;
      splash?.close();
      splash = undefined;
    });
    function saveRuntime(port: number) {
      if (process.platform === "win32") {
        // ACT: Switching connections also updates the port; the launcher
        // uses the PID to ignore records left by exited processes.
        writeAtomicSync(resolve(PATHS.RESOURCES_FOLDER, "desktopRuntime.json"), JSON.stringify({ pid: process.pid, port }));
      }
    }
    saveRuntime(connection.port);
  } catch (error) {
    await desktopConnection?.close().catch(error => console.error("设备连接关闭失败：", error));
    splash?.close();
    console.error("桌面启动失败：", error);
    if (process.platform === "win32") {
      try { confirmWindowsUpdateStartup(PATHS.RESOURCES_FOLDER, true); }
      catch (resultError) { console.error("更新启动结果写入失败：", resultError); }
    }
    Utils.quit(1);
  }
}

void start();
