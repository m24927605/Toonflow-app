# Contributing

Welcome to Toonflow. Whether you report issues, improve documentation, build plugins, or fix code, you help creators finish their work more smoothly.

Before joining discussions and collaborating, please read the [Code of Conduct](./CODE_OF_CONDUCT.md). See the [README](./README.md) for the project introduction and usage, the [Development and Extension Guide](./docs/development.md) for complete development instructions, and the [Development Conventions](./AGENTS.md) for the rules that code changes must follow.

## Where to Start

- **Report issues**: search existing reports in [GitHub Issues](https://github.com/HBAI-Ltd/Toonflow-app/issues) first, then add information or open a new issue.
- **Suggest improvements**: describe the creative scenario, the limitation you ran into, and the result you expect. Discuss the scope and impact of larger feature or architecture changes first.
- **Improve documentation**: fix mistakes, fill in missing steps, or provide reproducible instructions.
- **Build extensions**: refer to the [Node Scaffold](./packages/nodeScaffold/readme.md), the [Tool Scaffold](./packages/toolScaffold/readme.md), and existing implementations.
- **Contribute code**: pick a well-defined problem and submit a focused Pull Request (PR).

You do not need to wait until you can change code to take part. Clear reproduction steps, redacted screenshots, and real usage feedback are just as valuable.

## Opening an Issue

Keep each issue to a single problem, and use a title that states where the error occurs or what behavior you expect. Please provide:

1. The Toonflow version; when running from source, include the relevant commit or branch.
2. The operating system, processor architecture, and whether you run the desktop app or a browser.
3. The shortest reproduction steps from a clean starting state, noting whether it happens every time.
4. The expected and actual results, with screenshots or a short video if needed.
5. Error logs related to the problem, keeping the error context and removing unrelated content.
6. For problems involving plugins or models, the plugin version, provider, and model name.

Remove API keys, access tokens, account information, and personal paths first. Do not upload a complete `data/` directory, real user configuration, private workspaces, or unauthorized assets; when an example is needed, use the smallest redacted content.

For security vulnerabilities or sensitive information that should not be public, describe the situation by [email](mailto:ltlctools@outlook.com) instead of disclosing exploitable details in a public issue.

## Setting Up the Development Environment

This repository uses Bun Workspaces. The Web app, the business Server, and the desktop app are developed in the same repository, so there is no separate frontend repository to clone.

- Install Git and **Bun 1.3.14**, the version specified in the root `package.json`, and confirm the version with `bun --version`.
- Use Bun to install dependencies and run scripts; do not mix in npm, Yarn, or pnpm installation flows.
- Unless stated otherwise, run the commands below in the repository root. The desktop app has additional platform requirements, described below.

To submit a PR, you can fork the repository first and then clone your fork. The example below starts from the project repository:

```sh
git clone https://github.com/HBAI-Ltd/Toonflow-app.git
cd Toonflow-app
bun install
```

### Web and Business Server

```sh
# On first development, or after changing nodes or tools, build and sync them to data/
bun run dev:plugins

# Start Web and the business Server together
bun run dev
```

Open `http://localhost:5173`; if that port is taken, use the address in the Vite terminal output. The business Server listens on `3000`, and Vite proxies `/api`, `/a2a`, and `/mcp` to `127.0.0.1:3000`. If startup fails, check for port conflicts first, and do not start the same service twice.

`dev` only starts Web and Server. **It does not run `dev:plugins` automatically and does not open the desktop window.** For everyday development, choose as needed:

| Command | Purpose |
| --- | --- |
| `bun run dev:web` | Starts only Vite; features that need the API still require a separately started business Server. |
| `bun run dev:server` | Starts only the business Server, with Bun watching source changes. |
| `bun run dev:plugins` | Builds nodes and tools once and syncs them to `data/`; it is not a watch command. |
| `bun run dev:desktop` | Builds and starts the desktop app after the platform preparation below. |

The update service is independent of the business Server and is not needed for ordinary development. When working on update features, use `bun run dev:updateServer` as described in the [Update Service Guide](./apps/updateServer/readme.md).

### Desktop Development (Optional)

The desktop scripts support **Windows x64, macOS arm64, and macOS x64** and must run on the matching system and architecture; Linux desktop builds are not currently supported.

- **Windows x64**: uses Electrobun 2.0.1. The window requires WebView2, and the build script calls `%WINDIR%/Microsoft.NET/Framework64/v4.0.30319/csc.exe` to compile the native helper. NSIS is required for building the Windows installer; it is not a prerequisite for ordinary Web or desktop development.
- **macOS**: install the Xcode Command Line Tools first. Apple Silicon uses Electrobun 2.0.1; Intel Macs use a separate Electrobun 1.18.1 compatibility build, so install its dependencies first:

```sh
# Intel Mac only; return to the repository root afterward
cd compat/macIntel
bun install --frozen-lockfile
cd ../..
```

Both Apple Silicon and Intel Macs need the native launcher library for the current architecture, prepared on that Mac. Run this before your first desktop development session or after updating the native launcher implementation:

```sh
bun packages/startup/scripts/buildMac.ts
```

After preparing your platform, start desktop development:

```sh
bun run dev:desktop
```

This command syncs the development nodes and tools, builds Web and MCP, and then starts the desktop app. The desktop host reuses the business Server and listens on a local port assigned by the system, so **you do not need to run `bun run dev` first**. It uses the built Web pages rather than the Vite hot-reload page; after changing Web, rebuild before verifying.

Behavior such as directory selection, native saving, protocol launching, and updates must be verified in the desktop host; browser verification cannot replace it. For installers, SDK preparation, and platform limitations, see the [Development and Build Guide](./docs/development.md).

## Finding Code and Building Extensions

| Area of change | Main entry point |
| --- | --- |
| Pages, canvas, settings, and frontend state | `apps/web/src/` |
| HTTP endpoints, Agent runtime, and server-side tools | `apps/server/src/` |
| Desktop host, native interaction, installation, and updates | `apps/desktop/`; the Intel Mac compatibility layer is in `compat/macIntel/` |
| Canvas nodes | `packages/nodes/`, [Node Scaffold](./packages/nodeScaffold/readme.md) |
| Agent tools and their interactive components | `packages/tools/`, [Tool Scaffold](./packages/toolScaffold/readme.md) |
| Model providers and skills | `packages/providers/src/`, `packages/skills/` |

When changing nodes or tools, edit the source in `packages/` and then run `bun run dev:plugins`. It writes to `build/nodes/` and `build/tools/` and **overwrites the development artifacts with the same names in `data/nodes/` and `data/tools/`**; do not edit those artifacts directly in place of source changes. The command does not clean up old artifacts, so after renaming or deleting a plugin, check the development directories for leftover files.

`bun run build:nodes` and `bun run build:tools` each clear their `build/` subdirectory and rebuild, without syncing to `data/`. Do not treat production builds as development plugin syncing. For other extension options, see the [Development and Extension Guide](./docs/development.md).

## Data and Workspace Boundaries

- Web/Server development uses `data/` in the repository root by default, and the desktop development script uses that directory explicitly too. It contains local data such as settings and plugins and must stay ignored by Git. Do not mix it with the data you use day to day, and do not let multiple server processes write to the same data directory or workspace at once.
- When verifying configuration or file writes, use a separate temporary data directory and workspace. The standalone Server can set `TOONFLOW_DATA_DIR` before startup; when reusing `createApp`, pass it through `dataDirectory`, and the directory must be settled before routes are loaded dynamically. Confirm the actual read and write location before saving, overwriting, or deleting anything.
- Frontend workspace file operations all reuse `useWorkspaceFiles`, the default export of `apps/web/src/lib/workspaceFiles.ts`; do not re-wrap Axios or build file API requests by hand. File `path` and `target` arguments are relative paths inside the workspace, and directory arguments are absolute paths.
- Debounced operations, save queues, and multi-step operations spanning an `await` take a snapshot of the directory string first and then use a fixed-directory instance, so switching projects does not write to the wrong directory. `readJson<T>` does not validate the business structure, so callers must still check the file markers and contents.
- Global settings keep using the settings API and `u.conf`; do not create additional configuration instances, and do not change full-overwrite saving into partial merging without a requirement. The project list is persisted by Pinia, and removing a list entry does not delete the workspace files. Write failures must be reported to the caller; never swallow the exception and return success.

## Keeping Changes Focused

Read [AGENTS.md](./AGENTS.md) before you start, then trace the relevant implementation and its callers. Fix the root cause in shared logic, and prefer reusing existing utilities, Stores, and dependencies.

- Each PR solves one well-defined problem; avoid bundling unrelated refactoring, formatting, or dependency upgrades.
- Use TypeScript by default. New files, directories, your own variables, functions, and constants all use lowerCamelCase, such as `userStore.ts` and `editorPanel/`; do not use kebab-case, snake_case, PascalCase, or all-uppercase. Existing exceptions do not justify new code, and type names keep TypeScript's type naming conventions.
- Keep functions small and focused, and extract logic only when it clearly helps reuse or readability. Do not add abstraction layers, new frameworks, or duplicate wrappers for simple requirements; implement only the scope that has been clearly discussed, and do not add placeholder content or extra features on your own.
- Across workspaces, use the package name and its declared exports instead of reaching into another package's `src/`. Third-party imports keep their original export names, without `as` aliases to change casing; new imports of Node built-in modules use `node:`, and type-only imports use `import type`.
- Keep the existing formatting; the Server uses double quotes, semicolons, and two-space indentation. Remove unused imports and variables, and do not add meaningless `async` wrappers.
- Explain intentional simplifications with an `ACT:` comment; when there is a known ceiling, state the limitation and the future upgrade path. Do not skip input validation, security, accessibility, or data-loss protection in the name of simplicity.
- Do not commit secrets, personal configuration, runtime data, workspace assets, or unrelated build artifacts.

When changing model providers, base the work on the actual API documentation, requests, and responses. When persistence, workspace files, or plugin installation are involved, keep the existing data boundaries and failure handling.

### Vue Component Conventions

- Your own components use lowerCamelCase for file names, import bindings, and template tags, for example `showBox.vue`, `import showBox from "./showBox.vue"`, `<showBox />`.
- Third-party components prefer kebab-case tags such as `<el-button />` and `<vue-flow />`, while script imports keep original export names such as `ElButton` and `VueFlow`. PascalCase is forbidden for all component template tags.
- All component attributes, dynamic bindings, and named `v-model` arguments use lowerCamelCase, such as `showArrow`, `:nodeTypes`, `v-model:snapEnabled`. Names required by Vue syntax, the HTML standard, or an interface, such as `v-if`, `aria-label`, and `data-*`, stay as they are.
- Top-level `.vue` blocks are ordered `<template>` → `<script>` → `<style>`; blocks you do not need may be omitted. DOM class names and style selectors use lowerCamelCase, and SCSS is nested following the DOM structure. Do not hand-edit declaration files generated by tools.

### Server Endpoint Conventions

- Keep using Bun, TypeScript, ES Modules, and Express. The standalone entry point `src/index.ts` listens in a single process; the desktop app reuses `createApp` through `@toonflow/server/app`, without importing the standalone startup entry point or adding a cluster.
- **One endpoint per file**: every `.ts` file under `src/routes/` is scanned as a route. A file default-exports a Router, registers only one HTTP method and path, and uses `"/"` inside the endpoint. Do not put utilities, types, or configuration in the routes directory, and do not add controller, service, or repository layers for simple endpoints.
- Routes are generated with the `/api` prefix from the file's relative path, with casing matching the path, and `index.ts` maps to its containing directory. For example, `routes/settings/get.ts` maps to `/api/settings/get`, and the HTTP method is determined by the registration statement in the file.
- After adding, moving, renaming, or deleting a route, run `bun run --cwd apps/server routes`. **Do not hand-edit the imports, registrations, or hash in `src/router.ts`**, and do not rely on builds or file watching to fill them in. Before changing a URL or HTTP method, search for and update all callers.
- In the Server, `@/` points to `apps/server/src/`. Business utilities go in the matching module under `utils/` and are exported through `src/utils.ts`; endpoints use `import u from "@/utils"`.
- External input reuses `validateFields` and Zod, with the source of query and path parameters specified explicitly. The middleware only validates and does not write defaults, transforms, or trimming results back to the request; normalize explicitly when needed.
- JSON responses reuse `success` and `error` and keep `{ code, data, message }`. The wrapper functions do not set the HTTP status, so call `res.status(...)` explicitly when needed. Ordinary exceptions go to the unified error handling middleware, and streaming responses keep the in-stream error handling and resource cleanup.

## Verifying Your Changes

Choose the existing commands and any necessary manual verification based on your change. Run environment preparation, type checking, and builds separately, without implicitly binding them to other commands.

### Desktop Prerequisites for Type Checking

The root `bun run typecheck` checks every workspace, including the desktop app. On Windows x64 or Apple Silicon, if you check types on their own before the first desktop build, prepare the Electrobun SDK first:

```sh
bun apps/desktop/node_modules/electrobun/bin/electrobun.cjs prepare
```

On an Intel Mac, install the compatibility SDK first and run a desktop development or build command once to generate the adapter files. Type checking itself does not install dependencies, generate adapter files, or compile native libraries. If you only changed Web or Server, you can run the matching workspace check below first.

### Choosing Commands for Your Change

Run all of the following commands from the repository root:

| Command | When to use it |
| --- | --- |
| `bun run --cwd apps/server routes` | Generates the registration file after server route files are added, moved, renamed, or deleted. |
| `bun run --cwd apps/web typecheck` | Checks Web TypeScript and Vue types. |
| `bun run --cwd apps/server typecheck` | Checks business Server types. |
| `bun run typecheck` | Checks types across all workspaces after the matching environment preparation; suited to shared interface or cross-package changes. |
| `bun run --cwd apps/web build` | Verifies the Web build, output to `build/web/`. |
| `bun run --cwd apps/server build` | Builds Server and MCP and outputs the skill and provider files; does not replace route generation. |
| `bun run build` | Builds tools, Web, Server, and MCP and outputs skills and providers; **does not include nodes, the desktop build, or type checking**. |
| `bun run build:desktop` | Builds the desktop app for the current platform and its bundled resources, including the node, tool, Web, and MCP builds. |
| `bun run package:desktop` | Rebuilds and produces the Windows NSIS installer or macOS DMG; requires the packaging prerequisites of that platform. |

To verify the built Web and the standalone Server, run `bun run dev:plugins` first the first time, then `bun run build` and `bun run start:server`, and visit `http://localhost:3000`. The standalone Server does not initialize nodes; copying only `build/` is not a complete installation, and do not run it on `3000` at the same time as the development Server.

For documentation-only changes, checking the content, commands, links, and Markdown rendering is enough. For code changes, type check, build, or verify by actually using the feature according to the affected scope; you do not need to run every command every time.

**Writing or adding any test files is forbidden in this repository, including test files under other names or suffixes; no test framework or automated check entry point is added by default.** Follow the existing development conventions and verify changes with the necessary commands and manual steps.

Record the real check results and what was not verified: passing type checks and builds does not mean real model calls, media generation, desktop installation, upgrades, or data persistence have been verified. When you hit existing errors in files you did not change, note their location and how they affect this verification.

## Submitting a Pull Request

Create your own working branch from the current code and keep the commits focused on this change. Review the diff before pushing to make sure no local data or unrelated files slipped in.

The PR title should state the problem it solves directly. The description should ideally include:

- **Problem and references**: the previous behavior, the affected usage scenarios, and related issues.
- **Result of the change**: what users will see change and which areas are affected.
- **How it was verified**: the commands actually run, reproduction steps, and results; attach necessary screenshots for UI changes.
- **Verification limits**: environments not run, model services not called, and installation or upgrade behavior not yet verified.
- **Compatibility impact**: when users need to migrate configuration or adjust existing workflows, describe the specific impact.

Keep updating the same PR based on review feedback. If anything in the discussion is unclear, you can add background or explain trade-offs; opening a PR does not guarantee the change will be merged.

## License and Assets

Toonflow is licensed under the [MIT License](./LICENSE). Before submitting code, documentation, images, fonts, or other assets, make sure you have the right to use them in this project, and keep any copyright and license notices that must be kept.

Third-party dependencies and assets follow their own licenses. Do not submit content of unknown origin, without authorization, or containing sensitive personal information.
