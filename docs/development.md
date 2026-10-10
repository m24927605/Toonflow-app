# Development and Extension Guide

[Back to the Toonflow home page](../README.md) · [Documentation index](./readme.md) · [Contributing Guide](../CONTRIBUTING.md) · [Development Conventions](../AGENTS.md)

This guide covers plugin development, running from source, desktop packaging, and release updates in detail. If you are new to the project, read the Contributing Guide first.

## 🧩 Plugins and Model Extensions

Manage installed nodes, tools, skills, agents, and editor extensions under “Settings → Plugins”, which also installs local plugin files and sets up FFmpeg. See the [Developer Documentation](https://qcn7xdsqgc4z.feishu.cn/docx/KNBNd9naqolsy6xjAOCcEAkqnRd) for plugin development.

| Extension type | Purpose | Development entry point |
| --- | --- | --- |
| Node | Adds interactive components, input and output ports, and node actions to the canvas. | [Node Scaffold](../packages/nodeScaffold/readme.md) · [Built-in nodes](../packages/nodes/) |
| Tool | Gives the Agent abilities such as workspace operations, search, and media generation, optionally with an interactive UI. | [Tool Scaffold](../packages/toolScaffold/readme.md) · [Built-in tools](../packages/tools/) |
| Skill | Describes creative workflows, methods, and operating conventions with `SKILL.md` and supporting material. | [Built-in skills](../packages/skills/) |
| Provider | Adapts each platform's model list, request parameters, and media results. | [Provider implementations](../packages/providers/src/) |

Configuration forms for nodes and tools all use `@form-create/element-ui` rules; when a required field is empty, the configuration button shows a red dot. A tool only receives its own configuration; the host does not pass the full application settings to tools directly.

The media interface includes extension types for images, video, and audio, and the actual capabilities are implemented by each provider. The built-in media providers, OpenAI, Higgsfield, APIMart, Metaso, and CompShare, cover image and video generation. Skills can be installed globally or placed in the `skill/` directory of the current workspace; when names collide, the workspace version takes precedence.

To operate Toonflow from an external coding tool, enable the service under “Settings → MCP” and copy the client configuration; both HTTP and stdio connections are supported. UI operations such as canvas and node actions require the Toonflow window or web page to stay open. See the [MCP Integration Guide](../packages/mcp/README.md) for details.

<details>
<summary><strong>Installing plugins in the desktop app from a web page</strong></summary>

Once the desktop client is installed, a web page can request a plugin installation through `toonflow://install`. The app first shows the type, file name, and download URL, and downloads and installs the plugin only after the user confirms.

```ts
const link = new URL("toonflow://install");
link.searchParams.set("type", "node");
link.searchParams.set("url", "https://example.com/plugins/exampleNode.umd.js");
window.location.href = link.href;
```

| `type` | File format | Install location |
| --- | --- | --- |
| `node` | `.umd.js` | `data/nodes/` |
| `tool` | `.tool.js` | `data/tools/` |
| `skill` | `SKILL.md`, `.zip`, `.tar`, `.tar.gz`, `.tgz` | `data/skills/<name>/` |
| `provider` | Media provider `.ts` | `data/providers/` |

The download URL must be HTTP/HTTPS, and the file name comes from the URL path. Nodes, tools, and skills with the same name can be updated when the version is higher; overwriting the same version or downgrading requires force install in Developer options. Providers never overwrite an item with the same name.

Ordinary plugins and skill packages are limited to 20 MB, and skills are also held to this limit after extraction; providers are limited to 2 MB. Skill packages support ZIP and TAR and must contain a `SKILL.md` with `name` and `description` frontmatter, with supporting resources placed in its directory. TAR packages use the plain USTAR format, without links or PAX/GNU extension entries.

The Windows installer registers the protocol; on macOS the app must be in `/Applications` or `~/Applications`. The ordinary browser development mode does not register the desktop protocol.

</details>

---

## 🛠️ Development and Builds

The frontend, business server, and desktop app are maintained in a single Bun Workspaces repository.

| Layer | Technology |
| --- | --- |
| Runtime and package management | Bun 1.3.14, Bun Workspaces |
| Frontend | Vue 3, Vite, TypeScript, Pinia, Element Plus, Vue Flow |
| Server | Bun, Express 5, Zod |
| Agent | Pi Agent SDK, tool plugins, Markdown skills and memory |
| Desktop | Electrobun; Windows uses WebView2 and an NSIS installer |
| 3D and media | Three.js, FFmpeg, extensible media providers |

### Local Development

Install Git and the project's pinned version of [Bun](https://bun.sh/) first, then run:

```sh
git clone https://github.com/HBAI-Ltd/Toonflow-app.git
cd Toonflow-app
bun install

# On first development or after changing plugins, build nodes and tools and sync them to data/
bun run dev:plugins

# Start Web and the business Server together
bun run dev
```

Open `http://localhost:5173`. The standalone Server listens on `3000` by default, and the Web development server proxies API requests. `dev` does not build or sync plugins automatically, so the first start needs the `dev:plugins` step above.

### Common Commands

Run the following commands in the repository root:

| Command | Purpose |
| --- | --- |
| `bun run dev:web` | Starts the Web development server on its own. |
| `bun run dev:server` | Starts the business Server on its own. |
| `bun run dev:plugins` | Builds nodes and tools and syncs them to the development data directory. |
| `bun run dev:desktop` | Syncs development plugins, builds Web, and starts the desktop app. |
| `bun run build` | Builds tools, Web, Server, and MCP, and outputs skill and provider files. |
| `bun run build:server` | Builds the nodes, tools, Web, Server, MCP, skills, and providers needed for standalone deployment; supports Linux. |
| `bun run build:nodes` | Builds nodes into `build/nodes/` without writing to `data/nodes/`. |
| `bun run build:tools` | Builds tools into `build/tools/` without writing to `data/tools/`. |
| `bun run start:server` | Runs the built server in `build/server/`. |
| `bun run build:desktop` | Builds the desktop app for the current platform and its bundled resources. |
| `bun run package:desktop` | Produces the Windows NSIS installer or macOS DMG for the current platform. |
| `bun run release:desktop <version> --auto` | Produces the installer and full update package for the current platform, plus a patch when a previous version exists. |
| `bun run typecheck` | Runs type checking for each workspace on its own. |
| `bun run --cwd packages/i18n extract` | Manually extracts the Chinese source strings and the source index; does not generate translations for other languages. |

Builds and type checking run separately. After adding, moving, or deleting a business endpoint, run `bun run routes` in `apps/server` to generate the routes.

### i18n Maintenance

The language dictionaries and translation runtime live in [`packages/i18n`](../packages/i18n/readme.md). Explicit display locations in Web are transformed at compile time by a Vite plugin, so business source code can keep using Chinese; dynamic text uses the `t` / `msg` tagged templates. The server uses a per-request language context so concurrent requests do not mix languages.

After changing Chinese text, run the `extract` command above manually, then fill in the same keys in the other locale files in `packages/i18n/src/locales/` (English and Traditional Chinese), keeping the placeholders. Development startup and builds neither extract automatically nor generate translations automatically. Translations are for display only and do not change user data, model text, or values used in business logic; providers, tools, nodes, the node scaffold subpackage, and the installer are outside the translation scope. See the [i18n Maintenance Guide](../packages/i18n/readme.md) for usage details, language fallback rules, and verification records.

<details>
<summary><strong>Running the built Web and Server locally</strong></summary>

When running from source for the first time, after installing dependencies, run:

```sh
bun run build:server
bun run start:server
```

Then open `http://localhost:3000`. These commands use the default `data/` in the repository root. On first start, the service initializes the built-in nodes, tools, skills, and providers from the build output and keeps existing plugin files. When moving to another directory or machine, handle the runtime dependencies, configuration, and workspaces together; copying only `build/` is not a complete installation.

The standalone Server runs as a single process. The desktop app reuses the same `createApp` and listens on a local port assigned by the system in the main process. Endpoints such as directory selection, native saving, and desktop updates are provided only by the desktop host.

</details>

<details>
<summary><strong>Desktop build preparation: Windows and macOS</strong></summary>

The desktop scripts support Windows x64, macOS arm64, and macOS x64 and must be built on the matching system and architecture.

**Windows x64**

Uses Electrobun 2.0.1. Packaging requires NSIS, found at `C:/Program Files (x86)/NSIS/makensis.exe` by default; set `NSIS_PATH` to use another path. The first packaging run downloads and verifies Microsoft's WebView2 bootstrapper.

```sh
bun run build:desktop
bun run package:desktop
```

The installer is written to `build/desktop/artifacts/toonflow-<version>-Setup.exe`.

**macOS**

Install the Xcode Command Line Tools first. Apple Silicon uses Electrobun 2.0.1; Intel Macs use the Electrobun 1.18.1 compatibility build in `compat/macIntel/`, whose dependencies must be prepared first:

```sh
# Intel Mac only
cd compat/macIntel
bun install --frozen-lockfile
cd ../..
```

Generate the native launcher library on a Mac of the matching architecture, then build:

```sh
bun packages/startup/scripts/buildMac.ts
bun run build:desktop
bun run package:desktop
```

The launcher script downloads a pinned version of the ThorVG source and verifies its digest. The artifacts are in `build/desktop/artifacts/macArm64/` and `build/desktop/artifacts/macX64/` respectively.

Local builds produce test packages without Developer ID signing or notarization by default; the ARM package from GitHub Actions is signed and notarized automatically with the configuration below, while Intel is still not re-signed. For a test app you built yourself and whose source you trust, if it is blocked by the quarantine attribute, you can remove the quarantine attribute from that app only, adjusting the path to its actual location:

```sh
xattr -dr com.apple.quarantine "/Applications/toonflow.app"
```

**Type checking and the SDK**

If you type check on Windows x64 or Apple Silicon before the first build, prepare the Electrobun SDK first:

```sh
bun apps/desktop/node_modules/electrobun/bin/electrobun.cjs prepare
bun run typecheck
```

On an Intel Mac, after installing the compatibility SDK, run a desktop development or build command first to generate the adapter files. Type checking does not implicitly install dependencies or compile native libraries.

</details>

<details>
<summary><strong>Releases, updates, and plugin syncing</strong></summary>

**Automatic releases from version tags**

Releases use a `vX.Y.Z` tag directly on an existing commit; no Git Flow or release branch is needed.

1. Commit the code to release, select that commit in SourceTree, and click **Tag**.
2. Enter the full tag name, for example `v2.0.0`, and confirm that the tag points to the commit you want to release.
3. In the tag list on the left, right-click the new tag, choose **Push Tag**, and select the official repository `origin` as the target. Push only this tag; do not check “Push all tags”.

Pushing the tag also uploads the commit it references, so there is no need to create or push a release branch. GitHub Actions automatically runs **Release desktop v2.0.0**, builds Windows x64, macOS ARM64, and macOS x64, and creates the matching GitHub Release once all of them succeed.

You can also run the following two commands in a terminal in the repository (replace `2.0.0` with this release's version):

```sh
git tag -a v2.0.0 -m "Release v2.0.0"
git push --no-follow-tags origin refs/tags/v2.0.0:refs/tags/v2.0.0
```

The version format is a lowercase `v` followed by `X.Y.Z`; both lightweight and annotated tags are supported. Use a new version number and never overwrite an existing tag. If the build fails, check the logs in Actions; rerun the job if the code is unchanged, and use a new version number after changing code.

**Building all three platforms at once**

In the GitHub repository, open **Actions → Release desktop → Run workflow**, choose the trusted branch to release, enter the version (for example `2.0.1`), leave `ref` empty, and run it. Pushing a `vX.Y.Z` tag triggers a release as well. Builds that include ARM require `ref` to point to the same commit as the branch or tag that triggered the workflow, so it cannot be used to switch to another commit; builds of only Windows or Intel can still specify another `ref`.

The workflow builds on Windows, Intel Mac, and Apple Silicon runners separately and, once all succeed, uploads everything to the matching GitHub Release:

| Platform | Installer | Update files |
| --- | --- | --- |
| Windows x64 | `toonflow-<version>-Setup.exe` | `stable-win-x64-*` |
| macOS Intel | DMG | `stable-macos-x64-*` |
| macOS Apple Silicon | DMG | `stable-macos-arm64-*` |

Each platform includes the full update package `.tar.zst`, the update manifest `*-update.json`, and a `<platformPrefix>-<oldHash>.patch` from **the latest GitHub release → the current version**. On the first release, when the platform's manifest is not found (HTTP 404), only the installer and full update package are produced; other network errors, invalid manifests, or a missing patch abort the build. The version must be higher than the previous version in the update source.

Builds always read the previous version's manifest and full package from GitHub Releases' `releases/latest/download` to generate patches. GitHub Actions uses the current workflow's repository (`GITHUB_SERVER_URL` / `GITHUB_REPOSITORY`), and local builds default to `HBAI-Ltd/Toonflow-app`. This address is written into the SDK's build configuration and is not affected by client settings. At runtime, the client chooses the update source under “Settings → About”; it defaults to the official source `https://api.toonflow.net/web/version/desktopUpdates` and can be switched to GitHub Releases. Developer options can save one custom update file directory URL, which then appears in the update source dropdown under About. The workflow uploads files to the GitHub Release; files for the official update service still need to be synced separately with the commands below.

The [Debug workflow](../.github/workflows/debug.yml) can build a single platform or all platforms; its artifacts are kept for 7 days and no Release is created. By default it builds only full packages; check `generatePatch` to verify incremental builds. CI builds and archive checks do not mean real installation, GUI startup, or macOS Gatekeeper behavior has been verified.

**ARM automatic signing and notarization: first-time setup**

In the GitHub repository, add the following under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Content |
| --- | --- |
| `MACOS_CERTIFICATE_BASE64` | A `.p12` file containing one valid **Developer ID Application** certificate and its private key, encoded as Base64. |
| `MACOS_CERTIFICATE_PASSWORD` | The non-empty password set when exporting that `.p12`. |
| `MACOS_NOTARIZATION_KEY_ID` | The Key ID of the App Store Connect team API key. |
| `MACOS_NOTARIZATION_ISSUER_ID` | The full Issuer ID of that team API key, not the Team ID. |
| `MACOS_NOTARIZATION_KEY_BASE64` | The `.p8` private key file of that API key, encoded as Base64. |

Run the following command in Windows PowerShell, replacing the path with your local certificate path. The command only copies to the clipboard; it does not print the certificate contents or create files. Then paste it into the `MACOS_CERTIFICATE_BASE64` Secret field:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\certificates\signing.p12')) | Set-Clipboard
```

Then run the following command separately, replacing the `.p8` path with your local file path, and save the clipboard contents to `MACOS_NOTARIZATION_KEY_BASE64`:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\certificates\AuthKey_YOUR_KEY_ID.p8')) | Set-Clipboard
```

After pasting and saving, you can run `Set-Clipboard -Value ''` to clear the clipboard. Enter the password directly into `MACOS_CERTIFICATE_PASSWORD`; do not put it in commands, source code, or chat logs. Base64 is only an encoding, not encryption; the P12, P8, their Base64 forms, and the password must never be committed to a public repository or uploaded as build artifacts.

Notarization uses an App Store Connect **team API key**; the Key ID, Issuer ID, and P8 must all belong to the same key with the required permissions. Replacing the signing P12 does not require replacing a notarization API key that is still valid and authorized. This authentication method needs neither an Apple ID password nor a Team ID; the P12 and its password are used for code signing.

Once configured, the ARM builds of both Debug and Release automatically import a temporary keychain, use Electrobun to sign the native code inside the app, the app in the full update package, the installer wrapper, and the DMG, and submit each for Apple notarization, wait for approval, and staple and verify the notarization ticket. The full update archive is generated after the app is notarized; before upload, the signatures and notarization tickets of the extracted app, the DMG, and the app inside the image are strictly verified again, along with a check that the Developer ID certificate imported for this build was used.

A missing Secret, no single valid Developer ID Application identity, Apple rejecting notarization, or a failed acceptance check all abort the build; it never falls back to an unsigned or unnotarized package. The temporary P12 is deleted when the import step ends; the P8 and keychain are deleted in the cleanup step after the build succeeds, fails, or is cancelled, and all of them live in the runner's temporary directory. The certificate Base64, password, and P8 Base64 are injected only into the credential preparation step, and the notarization API identifiers are additionally passed only to the ARM build step. Waiting for notarization counts toward the workflow's existing 90-minute timeout, and nothing is released on timeout.

The public repository only triggers signing from trusted manual runs or `v*` tags and does not use `pull_request` / `pull_request_target`. Protect the release branch and `v*` tags with GitHub Rulesets and restrict write access to the repository; signed builds run the code of the selected commit, so anyone who can change the release code or workflows is also inside the trust boundary of the Secrets. For how certificates are imported, see [GitHub's official instructions](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications).

ARM CI builds require both signing and notarization, while local builds do not enable them by default; the old SDK re-signing limitation for Intel is unchanged. Notarization does not require publishing to the App Store, and the first launch may still show a prompt confirming that you want to open an app downloaded from the internet. CI acceptance does not replace verifying download from a browser, installation, launch, and upgrade on a real Mac; see [Apple's instructions on opening apps safely](https://support.apple.com/en-us/102445).

If the credential preparation step reports “未找到唯一有效的 Developer ID Application 身份” (no single valid Developer ID Application identity found), check the certificate category, validity period, and system diagnostics in that step's later output. `Apple Development`, `Apple Distribution`, and `Developer ID Installer` cannot replace the required `Developer ID Application`. If the category is correct, still check whether the matching private key is included, whether the certificate has expired, and the certificate trust chain; successfully importing the P12 does not mean a valid code-signing identity exists. The diagnostics never print the private key, password, or certificate holder name.

**Local packaging and the standalone update service**

The standalone update service runs separately from the business Server, at `http://127.0.0.1:8091` by default. For its configuration, deployment, and release rules, see the [Update Service Guide](../apps/updateServer/readme.md).

```sh
bun run start:updateServer

# Local builds cover only the current system and architecture; automatically detect whether a previous version exists
bun run release:desktop 2.0.0 --auto
bun run publish:update build/desktop/releases/2.0.0

# When the server keeps the previous version, build and publish the next version
bun run release:desktop 2.0.1
bun run publish:update build/desktop/releases/2.0.1
```

Mac release directories add `macX64/` or `macArm64/`, for example `build/desktop/releases/macArm64/2.0.1`. Every release mode produces an installer; `--auto` detects the baseline automatically, running without options requires a previous version, and `--initial` skips the baseline check and produces no patch. A snapshot cannot be generated twice for the same platform, architecture, and version. The ordinary `build:desktop` and `package:desktop` do not contact the update server.

Desktop users can check for updates, download them, and restart the app under “Settings → About”. Windows updates swap the program directory and keep `data/` and `WebView2/`; uninstalling also keeps this data by default, and it is removed only when “Also delete user data” is selected.

Built-in nodes and tools are synced by build hash: the first start after an upgrade or downgrade replaces built-in plugins with the same name, and reinstalling the same version on Windows also triggers a sync. Ordinary restarts do not overwrite them again. Skills and providers follow the first-initialization rules and keep existing files; third-party plugins and user assets are not overwritten when built-in nodes and tools are synced.

</details>

### Project Structure

```text
apps/
  web/                 Vue pages, settings, workspaces, and canvas
  server/              Business API and Agent runtime, shared by the desktop app
  desktop/             Electrobun entry point, build scripts, and installer
  updateServer/        Standalone update file server and release scripts
packages/
  assets/              Shared images and icons
  i18n/                Language dictionaries, runtime, and text extraction
  nodes/               Built-in canvas nodes
  nodeScaffold/        Node development scaffold and runtime
  tools/               Agent tool plugins
  toolScaffold/        Tool development scaffold and runtime
  providers/           Text and media model providers
  skills/              Markdown skills and supporting material
  mcp/                 MCP service and protocol adapters
  ffmpeg/              FFmpeg capabilities
  startup/             Native startup window and animation
docs/                  Development documentation and images
compat/macIntel/       Intel Mac compatibility build
build/                 Build output
data/                  Local runtime data, not committed to the repository
```

---
