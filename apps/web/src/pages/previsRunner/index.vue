<template>
  <div class="previsRunner">{{ status }}</div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useNodeAi, type NodeAiRequest } from "@toonflow/nodes-scaffold/runtime";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { installNodeHost } from "@/lib/nodeHost";
import { loadNodeComponent } from "@/pages/workspace/panels/canvas/loadNodeComponent";

/**
 * What the server's previs step hands this page before it loads: the workspace, where the files go, the director
 * model, the script and shot list the instructions refer to as {{ref 1}} and {{ref 2}}, one instruction per shot still
 * to block, and the set and plans of the shots a stopped run already finished.
 */
type PrevisJob = {
  directory: string; folder: string; providerId: string; modelId: string; aspect: number; script: string; shotList: string;
  shots: { shot: number; instruction: string; cast: string[]; size: string; seconds: number }[];
  start?: { scene: unknown; plans: unknown[] };
};
type RunPrevis = (options: {
  generate: (request: Omit<NodeAiRequest, "onEvent">) => Promise<unknown>; providerId: string; modelId: string; aspect: number; signal: AbortSignal;
  shots: PrevisJob["shots"]; start?: PrevisJob["start"];
  onShot: (result: { shot: number; layout: Blob; video: Blob; blocking: string; scene: unknown; plans: unknown[] }) => Promise<void>;
}) => Promise<void>;
type RunnerWindow = typeof window & { previsJob?: PrevisJob; previsResult?: { done?: { shot: number; layout: string; video: string; blocking: string }[]; error?: string } };

// A page without the workspace UI that the server opens in a headless browser for auto production's previs. It works
// on the directory the job names and never opens a project, so the people's own pages keep their current project.
const status = ref("");
const runner = window as RunnerWindow;
installNodeHost();
const ai = useNodeAi();

onMounted(async () => {
  const job = runner.previsJob;
  const done: NonNullable<NonNullable<RunnerWindow["previsResult"]>["done"]> = [];
  try {
    if (!job) throw new Error("No previs job");
    const files = useWorkspaceFiles(job.directory);
    await files.mkdir(job.folder).catch(() => undefined);
    const director = await loadNodeComponent("director3dNode", "/api/nodes/files?name=director3dNode") as unknown as { runPrevis?: RunPrevis };
    if (!director.runPrevis) throw new Error("The Director's Studio plugin cannot run previs; update it");
    const references: NodeAiRequest["references"] = [{ dataType: "STRING", value: job.script }, { dataType: "STRING", value: job.shotList }];
    await director.runPrevis({
      generate: request => ai.generate({ ...request, references }), providerId: job.providerId, modelId: job.modelId, aspect: job.aspect,
      signal: new AbortController().signal, shots: job.shots, start: job.start,
      async onShot({ shot, layout, video, blocking, scene, plans }) {
        status.value = `shot ${shot}`;
        const paths = { layout: `${job.folder}/shot${shot}.png`, video: `${job.folder}/shot${shot}.mp4` };
        await files.write(paths.layout, layout);
        await files.write(paths.video, video);
        // Written last, so a shot counts as done only once its media are saved; a stopped run resumes after it.
        await files.writeJson(`${job.folder}/shot${shot}.json`, { blocking, scene, plans });
        done.push({ shot, ...paths, blocking });
      },
    });
    runner.previsResult = { done };
  } catch (error) {
    runner.previsResult = { done, error: error instanceof Error ? error.message : String(error) };
  }
});
</script>

<style scoped lang="scss">
.previsRunner { padding: 16px; font-size: 12px; }
</style>
