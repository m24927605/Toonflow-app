import { $ } from "bun";
import { readdir, rm } from "@toonflow/file";
import { resolve } from "node:path";

const projectDir = resolve(import.meta.dirname, "../../..");

// ACT: Bun 1.3.14's --filter misreads lowerCamelCase directories on Linux; once fixed, reuse the root batch build command.
for (const group of ["nodes", "tools", "ext"]) {
  const groupDirectory = resolve(projectDir, "packages", group);
  await rm(resolve(projectDir, "build", group), { recursive: true, force: true });
  for (const entry of await readdir(groupDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await $`${process.execPath} run build`
      .cwd(resolve(groupDirectory, entry.name))
      .env({ ...process.env, NODE_ENV: "production" });
  }
}

await $`${process.execPath} run build`.cwd(resolve(projectDir, "apps/web"));
await $`${process.execPath} run build`.cwd(resolve(projectDir, "apps/server"));
