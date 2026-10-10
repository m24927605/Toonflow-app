# Development and Extension Guide

[Back to the Toonflow home page](../README.md) · [Documentation index](./readme.md) · [Development Conventions](../AGENTS.md)

This guide covers plugin development, running from source, and desktop packaging.

## 🧩 Plugins and Model Extensions

Manage installed nodes, tools, skills, agents, and editor extensions under “Settings → Plugins”, which also installs local plugin files and sets up FFmpeg.

| Extension type | Purpose | Development entry point |
| --- | --- | --- |
| Node | Adds interactive components, input and output ports, and node actions to the canvas. | [Node Scaffold](../packages/nodeScaffold/readme.md) · [Built-in nodes](../packages/nodes/) |
| Tool | Gives the Agent abilities such as workspace operations, search, and media generation, optionally with an interactive UI. | [Tool Scaffold](../packages/toolScaffold/readme.md) · [Built-in tools](../packages/tools/) |
| Skill | Describes creative workflows, methods, and operating conventions with `SKILL.md` and supporting material. | [Built-in skills](../packages/skills/) |
| Provider | Adapts each platform's model list, request parameters, and media results. | [Provider implementations](../packages/providers/src/) |

Configuration forms for nodes and tools all use `@form-create/element-ui` rules; when a required field is empty, the configuration button shows a red dot. A tool only receives its own configuration; the host does not pass the full application settings to tools directly.

The media interface includes extension types for images, video, and audio, and the actual capabilities are implemented by each provider. The built-in media providers, OpenAI, Higgsfield, Google Gemini and Metaso, cover image, video and speech generation. Skills can be installed globally or placed in the `skill/` directory of the current workspace; when names collide, the workspace version takes precedence.

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
git clone <repository-url> Toonflow-app
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

The standalone Server runs as a single process. The desktop app reuses the same `createApp` and listens on a local port assigned by the system in the main process. Endpoints such as directory selection and native saving are provided only by the desktop host.

</details>

<details>
<summary><strong>Desktop build preparation: Windows and macOS</strong></summary>

The desktop scripts support Windows x64 and macOS arm64 (Apple Silicon) and must be built on the matching system.

**Windows x64**

Uses Electrobun 2.0.1. Packaging requires NSIS, found at `C:/Program Files (x86)/NSIS/makensis.exe` by default; set `NSIS_PATH` to use another path. The first packaging run downloads and verifies Microsoft's WebView2 bootstrapper.

```sh
bun run build:desktop
bun run package:desktop
```

The installer is written to `build/desktop/artifacts/toonflow-<version>-Setup.exe`.

**macOS**

Install the Xcode Command Line Tools first. macOS uses Electrobun 2.0.1.

Generate the native launcher library, then build:

```sh
bun packages/startup/scripts/buildMac.ts
bun run build:desktop
bun run package:desktop
```

The launcher script downloads a pinned version of the ThorVG source and verifies its digest. The artifacts are in `build/desktop/artifacts/macArm64/`.

Local builds are not signed with a Developer ID or notarized. For an app you built yourself and whose source you trust, if it is blocked by the quarantine attribute, you can remove the quarantine attribute from that app only, adjusting the path to its actual location:

```sh
xattr -dr com.apple.quarantine "/Applications/toonflow.app"
```

**Type checking and the SDK**

If you type check before the first build, prepare the Electrobun SDK first:

```sh
bun apps/desktop/node_modules/electrobun/bin/electrobun.cjs prepare
bun run typecheck
```

Type checking does not implicitly install dependencies or compile native libraries.

</details>

<details>
<summary><strong>Built-in plugin syncing and uninstalling</strong></summary>

Built-in nodes and tools are synced by build hash: the first start after installing a different build replaces built-in plugins with the same name, and reinstalling the same version on Windows also triggers a sync. Ordinary restarts do not overwrite them again. Skills and providers follow the first-initialization rules and keep existing files; third-party plugins and user assets are not overwritten when built-in nodes and tools are synced.

Uninstalling on Windows keeps `data/` and `WebView2/` by default; they are removed only when “Also delete user data” is selected.

</details>

### Project Structure

```text
apps/
  web/                 Vue pages, settings, workspaces, and canvas
  server/              Business API and Agent runtime, shared by the desktop app
  desktop/             Electrobun entry point, build scripts, and installer
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
build/                 Build output
data/                  Local runtime data, not committed to the repository
```

---
