# Toonflow Android

> X5 integration is not finished: it still lacks the new dynamic SDK (44382) provided by the Tencent console and a `config.tbs` bound to `com.toonflow.mobile` and the APK signature. The current 44286 native code is a draft integration waiting to be replaced and must not be released as the new X5 version; the X5 flow described below is the target behavior. The official [public network integration guide](https://st.tencent-cloud.com/jax-static/tbs/PublicNetGuide0724.md) and [trial application guide](https://st.tencent-cloud.com/jax-static/TBS-WebIndex/docs/1005/console_doc.md) describe the required materials; for ARM64, choose the `x5webview64` component.

An Android WebView loads the real Toonflow frontend and backend started by Bun inside the same APK. The pages reuse `apps/web`, the backend is integrated through `@toonflow/server/app`, and the bundled nodes, tools, extensions, providers and skills reuse the existing build outputs.

## Device Link and manual connection

On the desktop, "Allow other devices to connect" under Settings → Device Link is off by default. Once enabled, a QR code is shown immediately, and `192.168.*` addresses are preferred for the local network address. On both phone and computer, click Device Link to the right of Settings on the Home page or on the first-run hello page, then use the camera or read a QR code image. You can also choose "Enter manually" and fill in the address and 12-digit pairing code from the other device's "Manual Connection Details". The QR code and numeric code have no time limit and share a single pairing attempt; refreshing, changing the Device Link configuration, turning Device Link off or restarting the server invalidates the old codes. The numeric code allows at most 10 attempts per minute; the QR code has no such limit. The port, shared working directories, other local network addresses and public HTTPS configuration all live under "Advanced options"; on first enable, the working directories of existing projects are used by default.

A computer can also connect to another computer. After connecting to a remote device, the local sharing listener and MCP service stop, and the current device acts only as a client; Settings shows the connection status and "Disconnect and run independently". After disconnecting and returning to independent mode, sharing can be turned on again; the port is not reopened automatically. When the desktop switches, it changes the local gateway port and reloads the window, keeping the local clipboard and file export capabilities; working directories come from the other server.

After a phone connects to a computer, the home page entry shows the actual connection status; click it to view the computer name, switch back to this device or connect to another computer. Scanning, confirming the connection and the current connection are shown separately, and the full action area is kept in landscape. The computer panel automatically updates the phone list and online status; the phone gateway checks the connection every five seconds, and the computer shows a device as offline after receiving no activity from it for more than fifteen seconds. Online means communication was possible recently; it does not mean the phone is in the foreground. Turning sharing off or revoking a device makes the phone's next check show that the connection is lost.

After connecting, the phone's local entry restarts, and pages, projects, model configuration and compute tasks come from the selected backend; the phone's existing projects stay on the phone. Click the connection status button on the home page again to switch servers or switch back to the phone; when the server is offline, retry and switch-back entries are also provided. Switching does not automatically migrate or merge projects or sync configuration between the two sides; running streaming tasks follow the existing cancel-on-disconnect behavior.

The phone still runs a lightweight Bun gateway to keep the localhost secure context and Android export capability; in remote mode, the phone's business backend is not initialized. The gateway forwards full pages, plugins and APIs, and supports uploads, Range, SSE/Agent response streams and cancellation. Device credentials are stored only in the phone app's private directory and are never handed to web pages; turning sharing off or revoking a device closes existing connections.

The sharing listener uses port `43123` by default and reuses the same backend process as the desktop. On first connection, allow this port through the computer's firewall; the computer must not be shut down or asleep. HTTP is for trusted local networks and is not encrypted; for public access, point an HTTPS reverse proxy at the **Device Link port**, then enter the HTTPS root address in the panel to generate a QR code. The proxy must preserve `X-Toonflow-Device-Token`, `Authorization` and the original Host, disable response buffering and allow long-lived connections. Do not expose the existing unauthenticated standalone main port directly.

A paired device can use that backend's model configuration and business features, so only authorize your own trusted devices. Shared directories define the scope of the workspace API, and the server's own `data/workspaces` is also accessible; this is not a sandbox for executing third-party plugin or Agent code. Do not edit the same canvas on the computer and the phone at the same time: Device Link does not provide multi-user real-time collaboration or conflict merging.

The app runs in landscape by default using `sensorLandscape`, switching between the two landscape orientations with the device. Immersive full screen hides the status bar and navigation bar, and swiping from the edge temporarily reveals the system bars; the Agent keeps its existing draggable, resizable and dockable floating window.

The phone uses 75% interface zoom by default; adjust it from 50% to 100% in 5% steps with the slider under Settings → Appearance → Interface zoom. While dragging, only the selected ratio is shown; it takes effect on release and is saved with the app settings. WebView viewport zoom is used, so the canvas and popups keep a unified coordinate system and the existing page layout and settings sidebar are preserved.

The official **Bun 1.4.2 Android** runtime is used, and only `arm64-v8a` is built. Packaging follows the native library directory startup approach of the community project [minapk](https://github.com/jjtseng93/minapk); the Android SDK is used directly for the build, with no dependency on its terminal environment. The Bun runtime is installed with the APK into the native library directory, JS, WASM and pages are copied into the app directory, and settings and workspaces are stored in a separate data directory. See [thirdParty.md](thirdParty.md) for sources and licenses.

On startup, the system WebView first loads a standalone local capability preflight page; once it passes, Toonflow opens directly without initializing or downloading X5. The checks share `@toonflow/web/browserCapabilities` with the web entry, so that an old engine does not show a blank screen while loading business dependencies.

Only when the system WebView lacks required capabilities is the Tencent TBS SDK initialized and X5 downloaded on demand. The download shows progress and failure messages; on non-Wi-Fi networks, data usage is confirmed first. An installed X5 can be reused; once X5 is confirmed to be in use, Toonflow opens directly without running browser capability checks on X5 again, and a silent SDK fallback to a system engine that does not meet the requirements is not accepted. X5 is used only on mobile; the actual engine version is delivered by Tencent's service, and no polyfills for old engines are added. Installing a newer Chrome or another WebView APK does not mean the system has switched to that version.

## Build

The current scripts are for Windows and require Bun, JDK 17 or later, Android SDK Platform 34 and Build Tools 35.0.0. Run from the repository root:

```powershell
# SDK / JDK already installed on this machine; adjust to the actual install paths on other machines.
$env:ANDROID_HOME = 'D:\SDK'
$env:JAVA_HOME = 'D:\Android Studio\jbr'

bun install
bun run --cwd apps/mobile setup
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile build
bun apps/mobile/scripts/verify.ts
```

`setup` explicitly downloads a pinned version of ARM64 Android Bun and Tencent's `com.tencent.tbs:tbssdk:44286` integration SDK, verifies their SHA256, and caches them in `build/mobile/runtime` and `build/mobile/tbs` respectively; the build itself does not download dependencies. The TBS integration SDK takes part in the Java / DEX build; the full X5 engine is not packed into the APK. Use `ANDROID_BUILD_TOOLS` and `ANDROID_PLATFORM` to adjust SDK versions.

`build` first calls the root `build:server`, which builds nodes, tools, extensions, frontend, backend and MCP, and then builds the mobile startup entry. The APK payload contains `server.js`, `web`, `nodes`, `tools`, `ext`, `providers`, `skills`, `mcp` and Photon's JS/WASM package; teams remain unbundled, as in the current repository. A `revision.txt` is generated from the payload contents and is used to update bundled plugins with each build.

`bun apps/mobile/scripts/verify.ts` must run on Bun 1.4.2 or later, matching the APK runtime (1.3.14 loses disconnect notifications after a request body has been consumed). It explicitly starts the real build outputs and, in a temporary data directory, verifies the capability preflight, the main pages, authentication, bundled resources, workspace boundaries, QR pairing, restart isolation, remote upload and Range, POST stream cancellation, offline recovery and phone export. The check does not connect to model providers, does not read existing user data and is not bound to the build automatically; it cannot replace on-device acceptance of the Android camera, X5 download and the system file picker.

Output: `build/mobile/toonflowMobile.apk`. The package name is `com.toonflow.mobile`, the minimum is Android 8 / API 26, and the target is API 34. Local builds and CI share the public default signing key in the repository, `native/defaultSigning.keystore`, with alias `androiddebugkey` and both passwords `android`. It keeps the previous local default signing instead of generating a new key each time, so later versions can be installed over earlier ones while keeping app data.

The version defaults to `app.version` in `electrobun.config.ts`; use `appVersion` to specify `X.Y.Z`. The Android `versionCode` is generated as `X × 1000000 + Y × 1000 + Z`, where Y and Z must not exceed 999 and the result must be within 1–2100000000; use a higher version number for updates.

## GitHub Actions

In Actions, choose **Debug build → Run workflow** and set `target` to `androidArm64` to build only the ARM64 APK, or choose `all` to build desktop and Android together. If the version is left empty, the selected tag or the project configuration is used. Android produces a debug package by default, which can be downloaded from the run's Artifacts or Summary. Enabling `androidRelease` turns off `debuggable` and removes the `-debug` suffix from the file name; both modes use the same default signing, and no Android Secrets need to be configured.

When a `vX.Y.Z` tag is pushed or a release is triggered manually, the existing **Release Toonflow** workflow builds desktop and Android in parallel, and after all succeed it attaches `toonflow-X.Y.Z-android-arm64.apk` to the same GitHub Release. The Android APK is not yet uploaded to the desktop update hosting API; the in-app "Update on GitHub" opens the latest release page.

CI uses the JDK 17 and Android SDK Manager bundled with Windows 2025, explicitly installs Platform 34 / Build Tools 35.0.0, and then runs dependency installation, mobile `setup` and `build` separately. The default signing file comes directly from the source tree; the Android build does not read signing Secrets. The X5 `config.tbs` must still match the final package name and the default signing.

To reproduce a release build locally, set `androidRelease=1` and run the same mobile `build` command.

## Install on an ARM64 device

```powershell
$adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe'
& $adb devices -l
& $adb -s <deviceSerial> install --no-incremental -r build/mobile/toonflowMobile.apk
& $adb -s <deviceSerial> shell am start -W -n com.toonflow.mobile/.mobileActivity
```

Use the device serial number shown by `adb devices`; only devices that run ARM64 native libraries are supported, and x86_64 APKs are no longer provided.

After launch, the Toonflow home page opens. After creating or opening a project, check that workspace files, canvases, nodes, the Agent and Settings load correctly; edit and save, quit the app, and reopen it: the content should be kept. Installing over the existing app keeps app data; uninstalling clears it.

## Phone workspaces and files

Projects use the app's private directory, and the file API still reuses Toonflow's workspace path validation and atomic saving. Import files through the Android system file picker and export files through the system save dialog; `content://` addresses returned by the system picker are not used as ordinary backend file paths.

The save dialog requests the internal storage `Download` directory as the initial location by default, and the user can still choose another location; when the system does not support that initial directory, it uses its own default location. On the local MuMu emulator, the "Downloads" shortcut has a write permission issue, so use "Internal storage → Download" when testing. Export to that location has been completed and the files verified to match.

Program resources and user data are stored separately: updating the APK can replace pages and plugins but cannot overwrite settings, projects or generated assets. Before migrating or uninstalling, export the files you need to keep.

```powershell
& $adb -s <deviceSerial> logcat -s ToonflowMobile AndroidRuntime
& $adb -s <deviceSerial> shell am force-stop com.toonflow.mobile
```

For local development, first run `bun run build:server` to prepare the real frontend and plugins, then run `bun run --cwd apps/mobile dev` and open the full URL printed in the terminal. Development data is stored separately in `build/mobile/data`.

## Current scope

- Reuses the real Toonflow frontend, backend and plugins; Bun listens only on a random local port, and app session authentication covers pages, APIs and streaming requests.
- Online model and media providers still need network access and a valid configuration; a local install does not mean cloud models run offline.
- FFmpeg currently has no Android distribution, so features that depend on FFmpeg, such as transcoding and frame extraction, are unavailable for now; Linux binaries cannot be used directly on Android.
- Bun stops when the Activity exits; there are no background long-running tasks or foreground services.
- Bun Android support is still experimental. Verification on MuMu cannot replace verification on a real ARM64 device; WebView, memory, media codecs and background behavior on real phones still need separate confirmation.
- Supports local Windows builds and GitHub Actions APK builds and signing; app store publishing is not included.
