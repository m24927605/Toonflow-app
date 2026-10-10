import { $ } from "bun";
import { cp, realpath, rm } from "@toonflow/file";
import { dirname, resolve } from "node:path";
import config from "../../../electrobun.config";

const projectDir = resolve(import.meta.dirname, "../../..");
const agentDirectory = dirname(await realpath(Bun.resolveSync("@earendil-works/pi-coding-agent", resolve(projectDir, "apps/server"))));
const photonDirectory = dirname(Bun.resolveSync("@silvia-odwyer/photon-node", agentDirectory));
// ACT: Teams are not bundled for now; uncomment to restore.
// await $`${process.execPath} run build:teams`.cwd(projectDir);
await $`${process.execPath} run build`.cwd(resolve(projectDir, "packages/mcp"));
// ACT: Ship Photon's JS together with its WASM so the runtime does not depend on the source directory or launch location.
await $`${process.execPath} build src/index.ts --target=bun --minify --external @silvia-odwyer/photon-node --define ${`process.env.appVersion:${JSON.stringify(config.app.version)}`} --outdir ../../build/server`.cwd(resolve(projectDir, "apps/server"));
const photonOutput = resolve(projectDir, "build/server/node_modules/@silvia-odwyer/photon-node");
await rm(photonOutput, { recursive: true, force: true });
await cp(photonDirectory, photonOutput, { recursive: true });
const skillsOutput = resolve(projectDir, "build/skills");
await rm(skillsOutput, { recursive: true, force: true });
await cp(resolve(projectDir, "packages/skills"), skillsOutput, { recursive: true });
const providersOutput = resolve(projectDir, "build/providers");
await rm(providersOutput, { recursive: true, force: true });
await cp(resolve(projectDir, "packages/providers/src"), providersOutput, { recursive: true });
