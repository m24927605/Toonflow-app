import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { McpOptions } from "@toonflow/mcp";
import { readFile } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { resolve } from "node:path";
import * as skillFile from "@/utils/skills/files";

export const skillResources: NonNullable<McpOptions["resources"]> = {
  async list(signal) {
    const { skills } = loadSkillsFromDir({ dir: skillFile.directory(), source: "user" });
    const resources = [];
    for (const skill of skills) {
      signal.throwIfAborted();
      if (!skillFile.isEnabled(skill.name)) continue;
      const { mainPath, files } = await skillFile.list(skill.name);
      for (const path of files) {
        const main = path === mainPath;
        resources.push({
          uri: `toonflow://skills/${encodeURIComponent(skill.name)}/${path.split("/").map(encodeURIComponent).join("/")}`,
          name: `${skill.name}/${path}`,
          description: main ? skill.description : `Supporting files of ${skill.name}: ${path}`,
          mimeType: file(main ? skill.filePath : resolve(skill.baseDir, path)).type || "application/octet-stream",
        });
      }
    }
    return resources;
  },
  async read(uri, signal) {
    signal.throwIfAborted();
    const match = /^toonflow:\/\/skills\/([^/]+)\/(.+)$/.exec(uri);
    if (!match) throw Object.assign(new Error("The skill resource address is invalid"), { status: 400 });
    const name = decodeURIComponent(match[1]!);
    if (!skillFile.isEnabled(name)) throw Object.assign(new Error("Skill disabled"), { status: 404 });
    const path = match[2]!.split("/").map(decodeURIComponent).join("/");
    const { mainPath, files } = await skillFile.list(name);
    if (!files.includes(path)) throw Object.assign(new Error("Skill resource does not exist"), { status: 404 });
    const { target } = await skillFile.locate(name, path === mainPath ? undefined : path);
    const bytes = await readFile(target, { signal });
    if (bytes.byteLength > skillFile.maxBytes) throw Object.assign(new Error("Skill file cannot exceed 20 MB"), { status: 413 });
    const mimeType = file(target).type || "application/octet-stream";
    let text: string | undefined;
    if (!bytes.includes(0)) {
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { /* Binary supporting files are returned as MCP blob content. */ }
    }
    return { contents: [text === undefined ? { uri, mimeType, blob: bytes.toString("base64") } : { uri, mimeType, text }] };
  },
};
