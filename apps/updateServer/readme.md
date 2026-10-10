# Update server

This is a standalone Bun + Express project: copy the whole `updateServer` folder to a server, install dependencies and run it. It only handles publishing update files and serving them as static downloads, and depends on neither the desktop app nor the business Server.

```powershell
cd apps/updateServer
bun install
bun run start
```

The default address is `http://127.0.0.1:8091` and no `.env` configuration is needed; to listen externally or change the port, edit `host` and `port` in `src/index.ts`. The update URL in the desktop build must point to a server address reachable by clients. `bun run dev` watches the source code.

## Application assembly

`createApp(publicDirectory)` in `src/app.ts` handles static downloads and unified error handling; `src/index.ts` only prepares directories and listens. JSON error responses use `src/lib/responseFormat.ts`, in the format `{ code, data, message }`. The command-line publish script is at `scripts/publish.ts`.

The service only accepts GET/HEAD, does not parse request bodies, does not grant cross-origin access and does not log requests. As a standalone project, it keeps its own dependencies and `@/` alias and does not import internal files of the business Server.

## Publishing updates

After copying the desktop build outputs to the server, publish from this project's directory:

```powershell
bun run publish <desktopBuildOutputDirectory>
```

The argument must be a directory containing exactly one `*-update.json`. The manifest's `platform` and `arch` must match the file name prefix. The new format reads the `.tar.zst` archive with the same prefix specified by `artifact.file`; when an Electrobun 1.18.1 Intel Mac legacy manifest has no `artifact`, the publisher looks in the same directory and accepts only one `.app.tar.zst` with the same prefix. Apple Silicon uses the new format with `artifact.file`.

The publisher also copies `.patch` files with the same platform and channel prefix, keeps old patches, replaces files first and atomically replaces the manifest last. `public/` is a static directory shared by all platforms; file name prefixes distinguish platform and architecture. Windows keeps `releases/<version>/` snapshots; Intel Mac and Apple Silicon are stored in `releases/macX64/<version>/` and `releases/macArm64/<version>/` respectively. The three targets can publish the same version number, but publishing the same version twice for the same target is rejected. Static downloads only serve GET/HEAD for flat ASCII file names, with caching disabled.

If copying or publishing fails, the snapshot directory created in this run and the current temporary files are cleaned up so it can be retried; existing snapshots are not deleted. Public files that were already replaced are not rolled back, so the publish process as a whole is not atomic.

After publishing the first baseline, keep the service running, then build the next version so that Electrobun downloads the baseline from this address and generates patches, and publish again. This service does not build the desktop app and provides no HTTP upload API; run only one publish command at a time.

Type check: `bun run typecheck`. Build: `bun run build`, which outputs to this project's `build/index.js`; start it with `bun build/index.js`, which still reads `public/` from the project root. The build does not install dependencies.
