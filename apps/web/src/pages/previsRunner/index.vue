<template>
  <div class="previsRunner">{{ status }}</div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useNodeAi, type NodeAiRequest } from "@toonflow/nodes-scaffold/runtime";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { installNodeHost } from "@/lib/nodeHost";
import { loadNodeComponent } from "@/pages/workspace/panels/canvas/loadNodeComponent";

type Shot = { shot: number; seconds: number; cast: string[]; size: string };
type PrevisPlan = { spec: unknown; plans: unknown[]; blocking: string[]; timeline?: string[]; framed: { opening: string[]; shown: string[]; gaze: Record<string, string>; looks: Record<string, string> }[] };
/**
 * What the server's previs step hands this page before it loads: the workspace, the previs folder and every shot of the
 * film. To plan, the director model and the script and shot list the plan refers to as {{ref 1}} and {{ref 2}}; the plan
 * is saved as plan.json in the folder. To render, the shots of that plan still to render and where each one's files go,
 * with a pose image path for each person whose pose render the server wants.
 */
type PrevisJob = { directory: string; folder: string; aspect: number; shots: Shot[] } & (
  | { mode: "plan"; providerId: string; modelId: string; script: string; shotList: string }
  | { mode: "render"; render: { shot: number; layout: string; depth: string; video: string; poses: Record<string, string> }[] }
);
type Director = {
  planPrevis?: (options: {
    generate: (request: Omit<NodeAiRequest, "onEvent">) => Promise<unknown>; providerId: string; modelId: string; shots: Shot[]; aspect: number; signal: AbortSignal;
    onStep?: () => void;
  }) => Promise<PrevisPlan>;
  renderPrevis?: (options: {
    plan: PrevisPlan; shots: Shot[]; rendered: number[]; aspect: number; signal: AbortSignal;
    onShot: (result: { shot: number; layout: Blob; depth: Blob; video: Blob; poses: Record<string, Blob> }) => Promise<void>;
  }) => Promise<void>;
};
// previsSteps counts the plan's finished steps, which the server takes as progress while the plan has nothing to save.
type RunnerWindow = typeof window & { previsJob?: PrevisJob; previsSteps?: number; previsResult?: Partial<Pick<PrevisPlan, "blocking" | "framed" | "timeline">> & { error?: string } };

// A page without the workspace UI that the server opens in a headless browser for auto production's previs. It works
// on the directory the job names and never opens a project, so the people's own pages keep their current project.
const status = ref("");
const runner = window as RunnerWindow;
installNodeHost();
const ai = useNodeAi();

onMounted(async () => {
  const job = runner.previsJob;
  try {
    if (!job) throw new Error("No previs job");
    const files = useWorkspaceFiles(job.directory);
    const director = await loadNodeComponent("director3dNode", "/api/nodes/files?name=director3dNode") as unknown as Director;
    if (!director.planPrevis || !director.renderPrevis) throw new Error("The Director's Studio plugin cannot run previs; update it");
    const signal = new AbortController().signal;
    const planPath = `${job.folder}/plan.json`;
    if (job.mode === "plan") {
      status.value = "plan";
      const references: NodeAiRequest["references"] = [{ dataType: "STRING", value: job.script }, { dataType: "STRING", value: job.shotList }];
      const plan = await director.planPrevis({
        generate: request => ai.generate({ ...request, directory: job.directory, references: [...references, ...request.references ?? []] }),
        providerId: job.providerId, modelId: job.modelId, shots: job.shots, aspect: job.aspect, signal,
        onStep: () => { runner.previsSteps = (runner.previsSteps ?? 0) + 1; },
      });
      await files.mkdir(job.folder).catch(() => undefined);
      await files.writeJson(planPath, plan);
      runner.previsResult = { blocking: plan.blocking, framed: plan.framed, timeline: plan.timeline };
      return;
    }
    const render = new Map(job.render.map(item => [item.shot, item]));
    await director.renderPrevis({
      plan: await files.readJson<PrevisPlan>(planPath), shots: job.shots, aspect: job.aspect, signal,
      rendered: job.shots.flatMap(({ shot }) => render.has(shot) ? [] : [shot]),
      async onShot({ shot, layout, depth, video, poses }) {
        status.value = `shot ${shot}`;
        const paths = render.get(shot)!;
        await files.write(paths.layout, layout);
        await files.write(paths.depth, depth);
        for (const [name, path] of Object.entries(paths.poses)) if (poses[name]) await files.write(path, poses[name]);
        // Written last, so a shot counts as rendered only once all its files are saved; a stopped run resumes after it.
        await files.write(paths.video, video);
      },
    });
    runner.previsResult = {};
  } catch (error) {
    runner.previsResult = { error: error instanceof Error ? error.message : String(error) };
  }
});
</script>

<style scoped lang="scss">
.previsRunner { padding: 16px; font-size: 12px; }
</style>
