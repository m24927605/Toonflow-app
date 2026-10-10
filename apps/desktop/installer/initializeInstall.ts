import { randomUUID } from "node:crypto";
import { copyFileSync, rmSync, writeAtomicSync } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { basename, isAbsolute, join } from "node:path";

const directories = process.argv.slice(2);
if (directories.length !== 3 || directories.some(directory => !isAbsolute(directory))) {
  throw new Error("需要安装目录、桌面目录和开始菜单目录的绝对路径。");
}
const [installDirectory, desktopDirectory, programsDirectory] = directories as [string, string, string];
const resourcesDirectory = join(installDirectory, "app", "Resources");
const { identifier, name, channel } = await file(join(resourcesDirectory, "version.json")).json();
if (typeof identifier !== "string" || typeof name !== "string" || channel !== "stable") {
  throw new Error("应用安装信息无效，请重新构建安装包。");
}

// ACT: NSIS handles system registration; fill in Electrobun 2.0.1's records so first launch does not call PowerShell again.
// Keep the real update helper and full manifest instead of using placeholder files to bypass SDK checks.
copyFileSync(join(resourcesDirectory, "uninstall"), join(installDirectory, "uninstall.exe"));
writeAtomicSync(join(installDirectory, ".electrobun-uninstall.json"), JSON.stringify({
  schema_version: 1,
  install_nonce: randomUUID().replaceAll("-", ""),
  identifier,
  name,
  channel,
  desktop_shortcut: join(desktopDirectory, `${name}.lnk`),
  start_menu_shortcut: join(programsDirectory, `${name}.lnk`),
  install_root_name: basename(installDirectory),
  data_path_versions: [1],
}, null, 2));

// Reinstalling the same build also resyncs built-in nodes, tools and
// providers; skills keep their first-run initialization and user edits.
for (const directory of ["nodes", "tools", "providers"]) {
  rmSync(join(installDirectory, "data", directory, "initialized"), { force: true });
}
