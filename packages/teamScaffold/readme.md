# Team Scaffold

`@toonflow/teams-scaffold` handles team manifest validation, directory packaging, and standard A2A integration. Models, sessions, workspace permissions, and member execution are provided by the host; a team package does not start a service and does not contain model keys.

## Developing a Team

Teams live in `packages/teams/<teamName>`; see `storyboardTeam` for reference:

```text
package.json
build.ts
team.json
readme.md
members/director.md
members/writer.md
skills/storyboard/SKILL.md
knowledge/continuity.md
tools/example.tool.js
```

`tools` can be omitted; it only accepts single-file tools built with the existing toolScaffold and does not bundle another SDK or model runtime.

```ts
import { createTeamConfig } from "@toonflow/teams-scaffold";

await createTeamConfig(import.meta.url, {
  sync: process.argv.includes("--sync") ? "replace" : "missing",
});
```

`createTeamConfig` reads `team.json` and `package.json` from the same directory as `build.ts`, uses `package.json.version` as the release version, and outputs `build/agents/<name>/` and `build/agents/<name>.agent.zip` under the project root. The build also checks the manifest, resource references, delegation cycles, and paths, and does not publish package.json, source dependencies, or build scripts.

`data/agents/<name>` is synced only when `NODE_ENV=dev`. By default only missing teams are installed, and existing install directories are kept intact so that prompts, skills, and knowledge modified by the user are not overwritten. Only an explicit `sync: "replace"` fully replaces the installation with this build's output, including deleting old files that no longer exist in the source; back up any changes you need to keep before using it. Confirmation for formal installation and upgrades is handled by the host.

Team names, member names, skill directory names, and tool plugin names use lowerCamelCase. The entry must be an existing member, and delegation relationships must not form a cycle; the director can call members separately multiple times, but member call chains cannot recurse.

Member fields:

| Field | Meaning |
| --- | --- |
| description | A summary of responsibilities for the coordinating member to see |
| instructions | Relative path of a Markdown file in `members/` |
| delegates | Names of members it may delegate to |
| tools | Actual tool names. When omitted, the host and team-private tools for the current turn are inherited; an empty array turns off ordinary tools; explicit names must be available in the current turn |
| skills | Directory names in `skills/<name>/SKILL.md` |
| knowledge | Relative file paths in `knowledge/`, or directory paths that contain files |

The root-level `tools` is a mapping from tool plugin name to configuration, corresponding to `tools/<name>.tool.js`. It differs from a member's list of actual tool names; a plugin can provide several tools. At runtime, the resources a member is authorized for are read on demand, and full content is not stuffed into the initial context. Private resources only indicate team scope; they cannot hide files from the local user and are not a sandbox for executable code.

A single file, the total size of unpacked files, and the archive are each limited to 20 MiB, and directories and files are limited to 2000 entries. Symbolic links, paths that escape the directory, Windows reserved file names, and case conflicts are rejected.

## A2A

Install `.agent.zip` under Settings → Plugins → Agent in Toonflow, where you can enable, disable, export, or uninstall it, or edit member instructions, skills, knowledge, and `team.json`. Teams are installed in `data/agents/<name>`; when an update finds local modifications, it asks for explicit confirmation before overwriting, and development builds do not overwrite them by default either. The team resource tool lets members read and write text within the scope granted by the manifest; it cannot be used to modify tool code or expand member authorization.

The main Agent calls teams with the existing `subAgent` tool, for example:

```json
{"tasks":[{"name":"Storyboard plan","team":"storyboardTeam","task":"Organize a text storyboard from story.md in the workspace. Read the original text first, and do not run media generation that consumes compute."}]}
```

Without `team`, it is still a temporary sub-Agent: no team needs to be installed, and it automatically inherits all of the parent Agent's tools, including asking questions and further delegation, without specifying `tools`. A team uses the model currently selected by the main Agent and the tools of the current turn; the scope available to members is still determined by the team manifest, and member contexts are independent. Tasks in the same batch run in parallel directly, with no concurrency quota or waiting queue. There is no fixed limit on the number of tasks, execution rounds, cumulative member calls, or total duration; team delegation relationships must still pass the manifest's acyclicity check. Members and tools are loaded when a task starts, and edits apply to later tasks; knowledge and Skill content are read when used. A running task is not terminated automatically when the plugin is disabled; cancel the task from the caller.

The external service is enabled under "A2A Service" on the same page: choose an explicitly authorized workspace and text model, save, then copy the access token and the Agent Card URL on the team card. It is off by default; remote calls cannot specify other local directories or models. Linux deployments only allow server workspaces, and the settings entry must be accessed from the local machine. When a page control connection exists, the canvas tools can be reused; without a connected page, only the currently available file and server tools are available.

"Connect to remote Agent" saves the external service's full Agent Card URL and an optional Bearer token; the connection name is also used in the `team` field of `subAgent`. Only the task text is sent to the remote side; model keys and host tools are not sent, and workspace files are not uploaded automatically. When `inputRequired` is returned, submit the additional content together with the original `taskId` and `contextId` to the same team. Remote usage is not counted in the model usage that can be verified locally.

`@toonflow/teams-scaffold/a2a` uses the official `@a2a-js/sdk` 1.2.0 with the A2A 1.0 protocol. The exported `AgentCard`, `Message`, `Task`, and `Artifact` are the SDK's original types; use the SDK's `fromJSON` / `toJSON` to convert wire JSON instead of assembling the internal oneof structures by hand.

```ts
import { createTeamAgentCard, createTeamA2aRouter } from "@toonflow/teams-scaffold/a2a";

app.use("/team", createTeamA2aRouter({
  card: createTeamAgentCard(manifest, "https://example.com/team"),
  authenticate: async request => verifyBearerAndGetStableUserId(request),
  execute: async ({ taskId, contextId, message, task, userId, signal, emit }) => {
    emit({ type: "status", text: "Running" });
    return runTeam({ taskId, contextId, message, task, userId, signal, emit });
  },
  onCancel: taskId => clearSavedSession(taskId),
}));
```

The host callback returns `{ status: "completed" | "inputRequired", text, artifacts? }`; exceptions are recorded as failures. Publish status text or standard Artifact updates through `emit`. When more information is needed, return `inputRequired` and the host saves its own session state; the next user message carries the original taskId and contextId and calls `execute` again, with task containing the saved protocol history. A task cannot be continued after it completes or fails.

The Card is at `/.well-known/agent-card.json` under the mount path and publishes a summary of the team's capabilities and the Bearer authentication declaration, without exposing private content. The host verifies the Bearer token and returns a stable identity; reading, listing, resuming, and canceling tasks are all isolated by that identity. The execute callback must handle the AbortSignal and wait for all child work to finish before the cancellation response confirms CANCELED; `onCancel` cleans up host state after the identity check passes and cancellation completes. An SSE disconnect does not cancel the task automatically.

Tasks, events, and identity indexes use the SDK's in-memory store and are not restored after a service restart; the host must clean up its saved model sessions itself. The first release does not provide push notifications or a legacy 0.3 compatibility layer.

```ts
import { createTeamA2aClient } from "@toonflow/teams-scaffold/a2a";

const client = await createTeamA2aClient({
  url: "https://example.com/team/.well-known/agent-card.json",
  token: "key read by the host",
});
const card = await client.getAgentCard();
```

The client returns the official Client, supporting its message, SSE, task read, list, and cancel interfaces; it can discover JSON-RPC or HTTP+JSON services. The URL passed in is the full Card URL. When a token is provided, the Card is not allowed to forward requests to another origin, and HTTP redirects are forbidden, so the key cannot leak through the Card or a redirect. This adapter does not download media files automatically.

## Verification

After changing the scaffold, run `bun run --cwd packages/teamScaffold typecheck`; for the example, run `bun run --cwd packages/teams/storyboardTeam build`. The build itself checks all member references, resource limits, and published content; actual member execution, authorization, and model calls still need to be tested together with the host.
