import { copyFile, mkdir, readFile, rename, rm } from "@toonflow/file";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { i18nPlugin } from "@toonflow/i18n/vite";
import type { Rule } from "@form-create/element-ui";
import { z } from "zod";
import postcssConfig from "../../postcss.config.ts";

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

export interface NodeConfig {
  name: string;
  displayName: string;
  author: string;
  github?: string;
  configRules?: Rule[];
}

export function createNodeConfig(config: NodeConfig, configUrl: string) {
  const { name: nodeName } = config;
  const metadata = {
    displayName: config.displayName.trim(),
    author: config.author.trim(),
    github: config.github?.trim() ?? "",
    configRules: z.array(z.record(z.string(), z.json())).max(100).parse(config.configRules ?? []),
  };
  if (!metadata.displayName) throw new Error("Plugin display name cannot be empty");
  if (metadata.github) {
    const githubUrl = new URL(metadata.github);
    if (githubUrl.origin !== "https://github.com" || githubUrl.username || githubUrl.password) throw new Error("GitHub URL must be under https://github.com");
  }
  const root = fileURLToPath(new URL(".", configUrl));
  if (!/^[a-z][a-zA-Z0-9]*$/.test(nodeName)) throw new Error(`Node name must use lowerCamelCase: ${nodeName}`);
  const fileName = `${nodeName}.umd.js`;
  const outDir = fileURLToPath(new URL("../../build/nodes", import.meta.url));
  const dataDir = fileURLToPath(new URL("../../data/nodes", import.meta.url));
  let syncToData = process.env.NODE_ENV === "dev";

  return defineConfig({
    root,
    css: { postcss: postcssConfig },
    plugins: [
      i18nPlugin(),
      vue(),
      {
        name: "syncNodeFile",
        configResolved(resolvedConfig) {
          syncToData ||= Boolean(resolvedConfig.build.watch) || resolvedConfig.mode === "development";
        },
        async generateBundle(_options, bundle) {
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== "chunk") throw new Error(`Node file not generated: ${fileName}`);
          const packagePath = resolve(root, "package.json");
          this.addWatchFile(packagePath);
          const packageInfo = JSON.parse(await readFile(packagePath, "utf8"));
          const version = typeof packageInfo.version === "string" ? packageInfo.version.trim() : "";
          if (!version) throw new Error(`Node package.json is missing a valid version: ${nodeName}`);
          const readmePath = resolve(root, "readme.md");
          this.addWatchFile(readmePath);
          const readme = await readFile(readmePath, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return "";
            throw error;
          });
          // Write after minification so the metadata comment isn't stripped.
          chunk.code = `/*! toonflowNode:${JSON.stringify({ ...metadata, version, readme }).replaceAll("/", "\\u002f")} */\n${chunk.code}`;
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
      // ACT: Single-package builds don't clean the shared output dir; the root build:nodes cleans it before batch builds.
      emptyOutDir: false,
      cssCodeSplit: true,
      lib: {
        entry: resolve(root, "src/index.vue"),
        name: `toonflowNodes.${nodeName}`,
        formats: ["umd"],
        fileName: () => fileName,
      },
      rolldownOptions: {
        external: ["vue", "@vue/runtime-core", "@vue/runtime-dom", "@vue-flow/core", "element-plus", "three", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@toonflow/i18n/vue", ...Object.keys(tiptapGlobals)],
        output: {
          exports: "default",
          globals: {
            ...tiptapGlobals,
            vue: "toonflowNodeHost.vue",
            "@vue/runtime-core": "toonflowNodeHost.vue",
            "@vue/runtime-dom": "toonflowNodeHost.vue",
            "@vue-flow/core": "toonflowNodeHost.vueFlow",
            "element-plus": "toonflowNodeHost.elementPlus",
            three: "toonflowNodeHost.three",
            "@earendil-works/pi-agent-core": "toonflowNodeHost.ai",
            "@earendil-works/pi-ai": "toonflowNodeHost.ai",
            // The host shares its dictionaries and reactive language, so switching languages updates nodes too.
            "@toonflow/i18n/vue": "toonflowNodeHost.i18n",
          },
        },
      },
    },
  });
}
