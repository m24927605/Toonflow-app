import type { Component } from "vue";
import type { Rule } from "@form-create/element-ui";

export type ExtResource =
  | { kind: "file"; directory: string; path: string; label: string }
  | { kind: "canvasNode"; directory: string; path: string; nodeId: string; label: string };

export interface ExtFiles {
  list(path?: string, signal?: AbortSignal): Promise<{ directory: string; entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  read(path: string): Promise<ArrayBuffer>;
  readText(path: string, maxBytes?: number, signal?: AbortSignal): Promise<string>;
  readJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T>;
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean, signal?: AbortSignal): Promise<void>;
  writeJson(path: string, data: unknown, exclusive?: boolean): Promise<void>;
  acquireUrl(path: string, mimeType?: string): { url: Promise<string>; release(): void };
  rename(path: string, target: string): Promise<void>;
  copy(path: string, target: string): Promise<void>;
  reveal(path: string): Promise<void>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface ExtContext {
  resource: ExtResource;
  files: ExtFiles;
  text: string;
  loading: boolean;
  error: string;
  dirty: boolean;
  active: boolean;
  config: Record<string, unknown>;
  saveConfig: (config: Record<string, unknown>) => Promise<void>;
  updateText: (text: string) => void;
  flushSave: () => Promise<void>;
  writeClipboardText: (text: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  location?: { line: number; column: number; query: string; revision: number };
  mountNode?: (element: HTMLElement) => Promise<() => void>;
}

export interface ExtDefinition {
  id: string;
  displayName: string;
  icon?: string;
  configRules?: Rule[];
  extensions: string[];
  resourceKind: ExtResource["kind"];
  text?: boolean;
  load: () => Promise<{ default: Component }>;
}

export function defineExt(definition: ExtDefinition): ExtDefinition {
  if (typeof definition.id !== "string" || definition.id.length > 96 || !/^ext-[a-z][a-zA-Z0-9]*$/.test(definition.id)) throw new Error(`Extension ID must be ext- followed by a lowerCamelCase name, at most 96 characters: ${definition.id}`);
  if (typeof definition.displayName !== "string" || !definition.displayName.trim()) throw new Error("Extension display name cannot be empty");
  if (definition.icon !== undefined) {
    const icon = definition.icon;
    if (typeof icon !== "string" || (icon && !/^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif)(?:;[^,]*)?,/i.test(icon)
      && !(URL.canParse(icon) && ["http:", "https:"].includes(new URL(icon).protocol)))) throw new Error("Extension icon must be an HTTP, HTTPS or image data URL");
  }
  if (definition.configRules !== undefined && (!Array.isArray(definition.configRules) || definition.configRules.length > 100)) throw new Error("Extension config rules must be an array of at most 100 form rules");
  if (definition.resourceKind !== "file" && definition.resourceKind !== "canvasNode") throw new Error("Invalid extension resource kind");
  if (definition.text !== undefined && typeof definition.text !== "boolean") throw new Error("Extension text flag must be a boolean");
  if (!Array.isArray(definition.extensions) || definition.extensions.some(extension => typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension))) throw new Error("File extensions must be lowercase letters or digits without a dot");
  if (definition.resourceKind === "file" && !definition.extensions.length) throw new Error("A file extension needs at least one suffix");
  if (new Set(definition.extensions).size !== definition.extensions.length) throw new Error("File extensions must be unique");
  if (typeof definition.load !== "function") throw new Error("Extension must provide a component loader function");
  return definition;
}
