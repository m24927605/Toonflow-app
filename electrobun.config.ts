import type { ElectrobunConfig } from "./.hutch/devkit/api/config/ElectrobunConfig";

const startupTarget = process.platform === "darwin" ? (process.arch === "x64" ? "macX64" : "macArm64") : "windowsX64";

export default {
  app: {
    name: "toonflow",
    identifier: "local.toonflow.desktop",
    version: process.env.appVersion ?? "2.0.0",
    urlSchemes: ["toonflow"],
  },
  build: {
    mainProcess: "bun",
    // ACT: Photon reads WASM from its package directory, so keep the package
    // intact to avoid referencing build-machine paths after inlining.
    bun: { entrypoint: "apps/desktop/src/index.ts", minify: true, external: ["@silvia-odwyer/photon-node"] },
    copy: {
      "build/desktop/photon": "bun/node_modules/@silvia-odwyer/photon-node",
      ...(process.platform === "win32" ? {
        "build/desktop/protocol/protocolLauncher.exe": "protocolLauncher.exe",
        "build/desktop/protocol/saveFileDialog.exe": "saveFileDialog.exe",
        "build/desktop/protocol/updateHelper.exe": "updateHelper.exe",
        "build/desktop/startup/windowsSplashWorker.js": "startup/windowsSplashWorker.js",
      } : {}),
      "build/web": "views/mainview",
      "build/mcp": "mcp",
      "build/tools": "tools",
      // ACT: Teams are not bundled for now; uncomment to restore.
      // "build/agents": "agents",
      "build/nodes": "nodes",
      "build/ext": "ext",
      "packages/providers/src": "providers",
      "packages/skills": "skills",
      "packages/startup/assets/startup.json": "startup/startup.json",
      "packages/startup/assets/license.txt": "startup/license.txt",
      [`packages/startup/assets/${startupTarget}`]: `startup/${startupTarget}`,
    },
    buildFolder: "build/desktop/app",
    artifactFolder: process.platform === "darwin" ? `build/desktop/artifacts/${process.arch === "x64" ? "macX64" : "macArm64"}` : "build/desktop/artifacts",
    win: {
      icon: "packages/assets/logo.ico",
    },
    mac: {
      icons: "packages/assets/logo.iconset",
      // ACT: CI enables both signing and notarization for ARM; test builds still work locally without credentials.
      codesign: process.env.macCodesign === "1",
      notarize: process.env.macCodesign === "1",
    },
  },
  release: {
    // ACT: Build baselines and patches always come from GitHub; the client
    // update source is set separately in settings and defaults to official.
    baseUrl: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || "HBAI-Ltd/Toonflow-app"}/releases/latest/download`,
    // ACT: Regular builds do not contact the update server; release:desktop explicitly enables delta builds.
    generatePatch: process.env.generateUpdatePatch === "1",
  },
  ...(process.platform === "darwin" ? {
    scripts: {
      postBuild: "apps/desktop/scripts/localizeMac.ts",
      postWrap: "apps/desktop/scripts/localizeMac.ts",
    },
  } : {}),
} satisfies ElectrobunConfig;
