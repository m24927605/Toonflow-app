import { dlopen, ptr, toArrayBuffer, type Pointer } from "bun:ffi";
import { createSplashPlayer } from "./splashPlayer";

export function showWindowsSplash(assetDir: string, onClose: () => void) {
  const user32 = dlopen("user32.dll", {
    CreateWindowExW: { args: ["u32", "ptr", "ptr", "u32", "i32", "i32", "i32", "i32", "u64", "u64", "u64", "ptr"], returns: "u64" },
    GetDpiForWindow: { args: ["u64"], returns: "u32" },
    GetSystemMetrics: { args: ["i32"], returns: "i32" },
    SetWindowPos: { args: ["u64", "u64", "i32", "i32", "i32", "i32", "u32"], returns: "i32" },
    UpdateLayeredWindow: { args: ["u64", "u64", "ptr", "ptr", "u64", "ptr", "u32", "ptr", "u32"], returns: "i32" },
    PeekMessageW: { args: ["ptr", "u64", "u32", "u32", "u32"], returns: "i32" },
    TranslateMessage: { args: ["ptr"], returns: "i32" },
    DispatchMessageW: { args: ["ptr"], returns: "i64" },
    SetWindowLongPtrW: { args: ["u64", "i32", "ptr"], returns: "ptr" },
    IsWindow: { args: ["u64"], returns: "i32" },
    DestroyWindow: { args: ["u64"], returns: "i32" },
  });
  const gdi32 = dlopen("gdi32.dll", {
    CreateCompatibleDC: { args: ["u64"], returns: "u64" },
    CreateDIBSection: { args: ["u64", "ptr", "u32", "ptr", "u64", "u32"], returns: "u64" },
    SelectObject: { args: ["u64", "u64"], returns: "u64" },
    DeleteObject: { args: ["u64"], returns: "i32" },
    DeleteDC: { args: ["u64"], returns: "i32" },
  });
  const native = user32.symbols;
  const dialogClass = Buffer.from("#32770\0", "utf16le");
  const windowTitle = Buffer.from("Toonflow 启动中\0", "utf16le");
  // ACT: A fixed native Windows x64 animation window on the primary display; no second WebView is created.
  // WS_EX_LAYERED | WS_EX_APPWINDOW + WS_POPUP | WS_SYSMENU: transparent and borderless,
  // keeping a close entry in the taskbar.
  const window = native.CreateWindowExW(0xc0000, ptr(dialogClass), ptr(windowTitle), 0x80080000, 0, 0, 400, 160, 0, 0, 0, null);
  let player: ReturnType<typeof createSplashPlayer> | undefined;
  let messageTimer: ReturnType<typeof setInterval> | undefined;
  let dc = 0n;
  let bitmap = 0n;
  let previousBitmap = 0n;
  let isClosed = false;
  let isEnded = false;
  const { promise: finished, resolve: finishAnimation } = Promise.withResolvers<void>();

  function close() {
    if (isClosed) return;
    isClosed = true;
    clearInterval(messageTimer);
    player?.close();
    if (previousBitmap) gdi32.symbols.SelectObject(dc, previousBitmap);
    if (bitmap) gdi32.symbols.DeleteObject(bitmap);
    if (dc) gdi32.symbols.DeleteDC(dc);
    if (window && native.IsWindow(window)) native.DestroyWindow(window);
    user32.close();
    gdi32.close();
    finishAnimation();
  }

  try {
    if (!window) throw new Error("无法创建原生启动窗口");
    // A plainly created #32770 does not handle close on its own;
    // let the system default window procedure handle taskbar close and Alt+F4.
    const kernel32 = dlopen("kernel32.dll", {
      GetModuleHandleW: { args: ["ptr"], returns: "u64" },
      GetProcAddress: { args: ["u64", "ptr"], returns: "ptr" },
    });
    try {
      const module = kernel32.symbols.GetModuleHandleW(ptr(Buffer.from("user32.dll\0", "utf16le")));
      const windowProc = kernel32.symbols.GetProcAddress(module, ptr(Buffer.from("DefWindowProcW\0")));
      if (!windowProc || !native.SetWindowLongPtrW(window, -4, windowProc)) throw new Error("无法设置启动窗口关闭处理");
    } finally {
      kernel32.close();
    }
    const scale = native.GetDpiForWindow(window) / 96;
    const width = Math.round(400 * scale), height = Math.round(160 * scale);
    native.SetWindowPos(window, 0, Math.round((native.GetSystemMetrics(0) - width) / 2), Math.round((native.GetSystemMetrics(1) - height) / 2), width, height, 0x14);
    dc = gdi32.symbols.CreateCompatibleDC(0);
    if (!dc) throw new Error("无法取得启动窗口画布");
    const bitmapInfo = new DataView(new ArrayBuffer(40));
    bitmapInfo.setUint32(0, 40, true);
    bitmapInfo.setInt32(4, width, true);
    bitmapInfo.setInt32(8, -height, true);
    bitmapInfo.setUint16(12, 1, true);
    bitmapInfo.setUint16(14, 32, true);
    const bits = new BigUint64Array(1);
    bitmap = gdi32.symbols.CreateDIBSection(dc, ptr(bitmapInfo.buffer), 0, ptr(bits), 0, 0);
    if (!bitmap || !bits[0]) throw new Error("无法创建透明启动画布");
    previousBitmap = gdi32.symbols.SelectObject(dc, bitmap);
    if (!previousBitmap) throw new Error("无法绑定透明启动画布");
    const pixels = new Uint8Array(toArrayBuffer(Number(bits[0]) as Pointer, 0, width * height * 4));
    player = createSplashPlayer(assetDir, width, height, pixels);
    const size = new Int32Array([width, height]);
    const origin = new Int32Array(2);
    // AC_SRC_OVER, global opacity 255, AC_SRC_ALPHA; the canvas uses premultiplied alpha.
    const blend = new Uint8Array([0, 0, 255, 1]);
    // MSG uses the 48-byte Windows x64 layout; only messages for this window and its children are handled.
    const message = new Uint8Array(48);
    const startedAt = performance.now();

    function draw() {
      isEnded = player!.draw(performance.now() - startedAt);
      if (!native.UpdateLayeredWindow(window, 0, null, ptr(size), dc, ptr(origin), 0, ptr(blend), 2)) throw new Error("透明启动画面绘制失败");
      if (isEnded) finishAnimation();
    }

    // Prepare the first frame before showing, so the launcher's SW_HIDE does not affect the first ShowWindow.
    draw();
    // Stay topmost during startup so the transparent logo is not hidden behind Explorer or the dev console.
    if (!native.SetWindowPos(window, 0xffffffffffffffffn, 0, 0, 0, 0, 0x53)) throw new Error("无法显示启动窗口");
    messageTimer = setInterval(() => {
      try {
        while (native.PeekMessageW(ptr(message), window, 0, 0, 1)) {
          native.TranslateMessage(ptr(message));
          native.DispatchMessageW(ptr(message));
        }
        if (!native.IsWindow(window)) {
          close();
          onClose();
          return;
        }
        if (!isEnded) draw();
      } catch (error) {
        console.error("原生启动动画失败：", error);
        close();
      }
    }, 1000 / 60);
    return {
      finish() {
        if (!isClosed) player!.finish(performance.now() - startedAt);
        return finished;
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
