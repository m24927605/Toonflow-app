import type { Plugin } from "vite";
import { transformSource } from "./transform.ts";

/** Web pages plus the canvas node sources, which reach the host's language state through `toonflowNodeHost.i18n`. */
export const translatedSource = /\/(?:apps\/web\/src|packages\/(?:nodes\/[^/]+|nodeShared|nodeScaffold)\/src)\//;

export function i18nPlugin(): Plugin {
  return {
    name: "toonflowI18n",
    enforce: "pre",
    transform(source, id) {
      const path = id.replaceAll("\\", "/");
      if (!translatedSource.test(path)) return;
      return transformSource(source, path);
    },
  };
}
