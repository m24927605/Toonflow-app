# Development and Extension Guide

[Back to the Toonflow home page](../README.md) · [Documentation index](./readme.md) · [Development Conventions](../AGENTS.md)

This guide covers plugin development and running from source.

## 🧩 Plugins and Model Extensions

Manage installed nodes, tools, skills, agents, and editor extensions under “Settings → Plugins”, which also installs local plugin files and sets up FFmpeg.

| Extension type | Purpose | Development entry point |
| --- | --- | --- |
| Node | Adds interactive components, input and output ports, and node actions to the canvas. | [Node Scaffold](../packages/nodeScaffold/readme.md) · [Built-in nodes](../packages/nodes/) |
| Tool | Gives the Agent abilities such as workspace operations, search, and media generation, optionally with an interactive UI. | [Tool Scaffold](../packages/toolScaffold/readme.md) · [Built-in tools](../packages/tools/) |
| Skill | Describes creative workflows, methods, and operating conventions with `SKILL.md` and supporting material. | [Built-in skills](../packages/skills/) |
| Provider | Adapts each platform's model list, request parameters, and media results. | [Provider implementations](../packages/providers/src/) |

Configuration forms for nodes and tools all use `@form-create/element-ui` rules; when a required field is empty, the configuration button shows a red dot. A tool only receives its own configuration; the host does not pass the full application settings to tools directly.

The media interface includes extension types for images, video, and audio, and the actual capabilities are implemented by each provider. The built-in media providers, OpenAI, Higgsfield, Google Gemini, Metaso, Sulphur 2 (Colab), Qwen-Image (Colab) and Suno, cover image, video, speech and music generation. Skills can be installed globally or placed in the `skill/` directory of the current workspace; when names collide, the workspace version takes precedence.

To operate Toonflow from an external coding tool, enable the service under “Settings → MCP” and copy the client configuration; both HTTP and stdio connections are supported. UI operations such as canvas and node actions require the Toonflow web page to stay open. See the [MCP Integration Guide](../packages/mcp/README.md) for details.

---

## 🛠️ Development and Builds

The frontend and business server are maintained in a single Bun Workspaces repository.

| Layer | Technology |
| --- | --- |
| Runtime and package management | Bun 1.4.2, Bun Workspaces |
| Frontend | Vue 3, Vite, TypeScript, Pinia, Element Plus, Vue Flow |
| Server | Bun, Express 5, Zod |
| Agent | Pi Agent SDK, tool plugins, Markdown skills and memory |
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
| `bun run dev:server` | Starts the business Server on its own and restarts it when its source changes. The restart uses `--watch-kill-signal=SIGUSR1`: since Bun 1.4 a watch restart first runs the handlers of that signal, and the default `SIGTERM` handler that `conf` installs through `atomically` re-raises the signal and ends the process instead of restarting it. |
| `bun run dev:plugins` | Builds nodes and tools and syncs them to the development data directory. |
| `bun run build` | Builds tools, Web, Server, and MCP, and outputs skill and provider files. |
| `bun run build:server` | Builds the nodes, tools, Web, Server, MCP, skills, and providers needed for standalone deployment; supports Linux. |
| `bun run build:nodes` | Builds nodes into `build/nodes/` without writing to `data/nodes/`. |
| `bun run build:tools` | Builds tools into `build/tools/` without writing to `data/tools/`. |
| `bun run start:server` | Runs the built server in `build/server/`. |
| `bun run typecheck` | Runs type checking for each workspace on its own. |
| `bun run --cwd packages/i18n extract` | Manually extracts the source strings (Chinese display text and explicit `translate`/`t`/`msg` messages) and the source index; does not generate translations for other languages. |

Builds and type checking run separately. After adding, moving, or deleting a business endpoint, run `bun run routes` in `apps/server` to generate the routes.

### i18n Maintenance

The language dictionaries and translation runtime live in [`packages/i18n`](../packages/i18n/readme.md). Explicit display locations in Web are transformed at compile time by a Vite plugin, which translates existing Chinese display text implicitly. New display text is written in English and must be marked explicitly with `translate("...")` (also in templates) or the `t` / `msg` tagged templates for dynamic text; unmarked English is shown as is. The server uses a per-request language context so concurrent requests do not mix languages.

After changing display text, run the `extract` command above manually, then fill in the same keys in the other locale files in `packages/i18n/src/locales/` (English and Traditional Chinese, plus Simplified Chinese in `zhCn.json` for English keys), keeping the placeholders. Development startup and builds neither extract automatically nor generate translations automatically. Translations are for display only and do not change user data, model text, or values used in business logic; canvas nodes share the app dictionaries, while provider and tool plugins and skills are outside the translation scope. See the [i18n Maintenance Guide](../packages/i18n/readme.md) for usage details, language fallback rules, and verification records.

<details>
<summary><strong>Running the built Web and Server locally</strong></summary>

When running from source for the first time, after installing dependencies, run:

```sh
bun run build:server
bun run start:server
```

Then open `http://localhost:3000`. These commands use the default `data/` in the repository root. On first start, the service initializes the built-in nodes, tools, skills, and providers from the build output and keeps existing plugin files. When moving to another directory or machine, handle the runtime dependencies, configuration, and workspaces together; copying only `build/` is not a complete installation.

The Server runs as a single process. Picking a folder with the system dialog, opening a file in the system file manager and the Agent's browser tool only work when running from source in development on the same computer.

</details>

<details>
<summary><strong>Built-in plugin syncing</strong></summary>

Built-in nodes, tools, document extensions and media providers are synced by a hash of their files: the first start after a build changes them replaces the built-in plugins with the same name, including Docker upgrades that keep the data volume. Ordinary restarts do not overwrite them again. Skills are only installed on first start and keep later edits; third-party plugins and user assets are never overwritten by the sync.

</details>

### Project Structure

```text
apps/
  web/                 Vue pages, settings, workspaces, and canvas
  server/              Business API and Agent runtime
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
docs/                  Development documentation and images
build/                 Build output
data/                  Local runtime data, not committed to the repository
```

---
