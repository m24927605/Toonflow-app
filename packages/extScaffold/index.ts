import { copyFile, mkdir, readFile, rename, rm } from "@toonflow/file";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadConfigFromFile } from "vite";
import vue from "@vitejs/plugin-vue";
import { i18nPlugin } from "@toonflow/i18n/vite";
import { z } from "zod";
import { defineExt, type ExtDefinition } from "./src/runtime.ts";

const tiptapGlobals = {
  "@tiptap/core": "toonflowTiptapHost.core",
  "@tiptap/vue-3": "toonflowTiptapHost.vue3",
  "@tiptap/starter-kit": "toonflowTiptapHost.starterKit",
  "@tiptap/markdown": "toonflowTiptapHost.markdown",
  "@tiptap/extension-find-and-replace": "toonflowTiptapHost.findAndReplace",
  "@tiptap/extension-highlight": "toonflowTiptapHost.highlight",
  "@tiptap/extension-image": "toonflowTiptapHost.image",
  "@tiptap/extension-list": "toonflowTiptapHost.list",
  "@tiptap/extension-subscript": "toonflowTiptapHost.subscript",
  "@tiptap/extension-superscript": "toonflowTiptapHost.superscript",
  "@tiptap/extension-table": "toonflowTiptapHost.table",
  "@tiptap/extension-text-align": "toonflowTiptapHost.textAlign",
  "@tiptap/pm/model": "toonflowTiptapHost.model",
  "@tiptap/pm/state": "toonflowTiptapHost.state",
  "@tiptap/pm/view": "toonflowTiptapHost.view",
  "marked": "toonflowTiptapHost.marked",
  "dompurify": "toonflowTiptapHost.dompurify",
};

export type ExtMetadata = Omit<ExtDefinition, "load">;

export function createExtConfig(config: ExtMetadata, configUrl: string) {
  defineExt({ ...config, load: async () => ({ default: {} }) });
  const root = fileURLToPath(new URL(".", configUrl));
  const fileName = `${config.id}.umd.js`;
  const outDir = fileURLToPath(new URL("../../build/ext", import.meta.url));
  const dataDir = fileURLToPath(new URL("../../data/ext", import.meta.url));
  let syncToData = process.env.NODE_ENV === "dev";

  return defineConfig({
    root,
    plugins: [
      i18nPlugin(),
      vue(),
      {
        name: "extBundle",
        enforce: "post",
        configResolved(resolvedConfig) {
          syncToData ||= Boolean(resolvedConfig.build.watch) || resolvedConfig.mode === "development";
        },
        async generateBundle(_options, bundle) {
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== "chunk") throw new Error(`Extension file not generated: ${fileName}`);
          const packagePath = resolve(root, "package.json");
          const readmePath = resolve(root, "readme.md");
          const metadataPath = resolve(root, "src/metadata.ts");
          this.addWatchFile(metadataPath);
          const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, metadataPath, root);
          if (!loaded) throw new Error(`Extension is missing the declaration file: ${metadataPath}`);
          for (const dependency of loaded.dependencies) this.addWatchFile(dependency);
          const { load: _load, ...metadata } = defineExt({ ...loaded.config as unknown as ExtMetadata, load: async () => ({ default: {} }) });
          if (metadata.id !== config.id) throw new Error("Restart the build command after changing the extension ID");
          const configRules = z.array(z.record(z.string(), z.json())).max(100).parse(metadata.configRules ?? []);
          this.addWatchFile(packagePath);
          this.addWatchFile(readmePath);
          const packageInfo = JSON.parse(await readFile(packagePath, "utf8"));
          const version = typeof packageInfo.version === "string" ? packageInfo.version.trim() : "";
          if (!version) throw new Error(`Extension package.json is missing a valid version: ${config.id}`);
          const readme = await readFile(readmePath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          let css = "";
          for (const [name, asset] of Object.entries(bundle)) {
            if (asset.type !== "asset" || !name.endsWith(".css")) continue;
            css += typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source);
            delete bundle[name];
          }
          const styleId = JSON.stringify(`toonflowExt-${config.id}`);
          const injectStyle = css ? `if(typeof document!=="undefined"){let style=document.getElementById(${styleId});if(!style){style=document.createElement("style");style.id=${styleId};document.head.appendChild(style)}style.textContent=${JSON.stringify(css)}}\n` : "";
          // Add metadata and styles after minification so a single JS file is enough for the extension loader.
          chunk.code = `/*! toonflowExt:${JSON.stringify({ ...metadata, configRules, version, readme }).replaceAll("/", "\\u002f")} */\n${injectStyle}${chunk.code}`;
        },
        async writeBundle() {
          if (!syncToData) return;
          await mkdir(dataDir, { recursive: true });
          const targetPath = resolve(dataDir, fileName);
          const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
          try {
            await copyFile(resolve(outDir, fileName), tempPath);
            await rename(tempPath, targetPath);
          } finally {
            await rm(tempPath, { force: true });
          }
        },
      },
    ],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir,
      // ACT: Multiple extensions share the directory, so building a single package keeps other extensions' outputs.
      emptyOutDir: false,
      cssCodeSplit: false,
      lib: {
        entry: resolve(root, "src/index.ts"),
        name: `toonflowExts.${config.id}`,
        formats: ["umd"],
        fileName: () => fileName,
      },
      rolldownOptions: {
        external: ["vue", "@vue/runtime-core", "@vue/runtime-dom", "element-plus", "@toonflow/i18n/vue", ...Object.keys(tiptapGlobals)],
        output: {
          exports: "default",
          codeSplitting: false,
          globals: {
            ...tiptapGlobals,
            vue: "toonflowExtHost.vue",
            "@vue/runtime-core": "toonflowExtHost.vue",
            "@vue/runtime-dom": "toonflowExtHost.vue",
            "element-plus": "toonflowExtHost.elementPlus",
            "@toonflow/i18n/vue": "toonflowExtHost.i18n",
          },
        },
      },
    },
  });
}
