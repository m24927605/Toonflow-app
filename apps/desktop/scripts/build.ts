import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "@toonflow/file";
import { dirname, resolve } from "node:path";

const projectDir = resolve(import.meta.dir, "../../..");
const mode = process.argv[2];
if (process.argv.length !== 3 || !["build", "dev", "typecheck", "package"].includes(mode!)) {
  throw new Error("用法：bun apps/desktop/scripts/build.ts <build|dev|typecheck|package>");
}
const isMac = process.platform === "darwin";
// ACT: typecheck only reads current sources and existing SDK files; it does not install dependencies or generate files.
if (mode === "typecheck") {
  await $`${process.execPath} run tsc --project apps/desktop/tsconfig.json`.cwd(projectDir);
  process.exit(0);
}
if (!(isMac && process.arch === "arm64") && !(process.platform === "win32" && process.arch === "x64")) {
  throw new Error("桌面构建需要 Windows x64 或 macOS arm64 环境。");
}
if (mode === "dev") process.env.TOONFLOW_DATA_DIR = resolve(projectDir, "data");
if (isMac) {
  for (const name of ["libthorvg.dylib", "nativeSplash.dylib"]) {
    if (!existsSync(resolve(projectDir, "packages/startup/assets/macArm64", name))) {
      throw new Error("缺少当前架构的 macOS 启动库，请先运行 bun packages/startup/scripts/buildMac.ts，再重新构建桌面应用。");
    }
  }
}
if (!isMac) {
  const startupBuild = await Bun.build({
    entrypoints: [resolve(projectDir, "packages/startup/src/windowsSplashWorker.ts")],
    outdir: resolve(projectDir, "build/desktop/startup"),
    target: "bun",
    minify: true,
  });
  if (!startupBuild.success) throw new AggregateError(startupBuild.logs, "启动动画线程构建失败。");
  const protocolDir = resolve(projectDir, "build/desktop/protocol");
  const csc = resolve(process.env.WINDIR!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  mkdirSync(protocolDir, { recursive: true });
  await $`${csc} /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /out:${resolve(protocolDir, "protocolLauncher.exe")} ${resolve(projectDir, "apps/desktop/native/protocolLauncher.cs")}`;
  await $`${csc} /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:${resolve(protocolDir, "saveFileDialog.exe")} ${resolve(projectDir, "apps/desktop/native/saveFileDialog.cs")}`;
}
// ACT: Teams are not bundled for now; when restoring, also add
// --filter './packages/teams/*' back to dev:plugins in package.json.
for (const script of mode === "dev" ? ["dev:plugins"] : [
  "build:tools",
  "build:nodes",
  "build:ext",
  // "build:teams",
]) {
  await $`${process.execPath} run ${script}`.cwd(projectDir);
}
await $`${process.execPath} run --filter @toonflow/web build`.cwd(projectDir);
await $`${process.execPath} run --filter @toonflow/mcp build`.cwd(projectDir);
const agentDirectory = dirname(realpathSync(Bun.resolveSync("@earendil-works/pi-coding-agent", resolve(projectDir, "apps/server"))));
const photonDirectory = dirname(Bun.resolveSync("@silvia-odwyer/photon-node", agentDirectory));
const photonOutput = resolve(projectDir, "build/desktop/photon");
rmSync(photonOutput, { recursive: true, force: true });
cpSync(photonDirectory, photonOutput, { recursive: true });
const cli = resolve(projectDir, "apps/desktop/node_modules/electrobun/bin/electrobun.cjs");
await $`${process.execPath} ${cli} ${mode === "dev" ? "dev" : "build"} ${mode === "dev" ? [] : ["--env=stable"]}`.cwd(projectDir);
if (mode === "package" && !isMac) {
  await $`${process.execPath} ${resolve(import.meta.dir, "packageWindows.ts")}`.cwd(projectDir);
}
