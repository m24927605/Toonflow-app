import * as vueRuntime from "vue";
import * as vueFlowRuntime from "@vue-flow/core";
import * as elementPlusRuntime from "element-plus";
import * as threeRuntime from "three";
import * as i18nRuntime from "@toonflow/i18n/vue";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, createInitialSystemMessage, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { NodeTypesObject } from "@vue-flow/core";
import { beginGeneration } from "@/lib/generationGuard";

export const nodeWindow = window as typeof window & {
  toonflowNodeHost?: {
    vue: typeof vueRuntime; vueFlow: typeof vueFlowRuntime; elementPlus: typeof elementPlusRuntime; three: typeof threeRuntime; i18n: typeof i18nRuntime;
    ai: { runAgentLoop: typeof runAgentLoop; createAssistantMessageEventStream: typeof createAssistantMessageEventStream; createInitialSystemMessage: typeof createInitialSystemMessage; getCurrentSystemPrompt: typeof getCurrentSystemPrompt; getCurrentTools: typeof getCurrentTools };
    generations: { begin: typeof beginGeneration };
  };
  toonflowNodes?: NodeTypesObject;
};

/** The shared runtimes node plugin builds read instead of bundling their own; set before any plugin script loads. */
export function installNodeHost() {
  nodeWindow.toonflowNodeHost = {
    vue: vueRuntime, vueFlow: vueFlowRuntime, elementPlus: elementPlusRuntime, three: threeRuntime, i18n: i18nRuntime,
    ai: { runAgentLoop, createAssistantMessageEventStream, createInitialSystemMessage, getCurrentSystemPrompt, getCurrentTools },
    generations: { begin: beginGeneration },
  };
}
