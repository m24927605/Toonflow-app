import { createHash } from "node:crypto";
import { z } from "zod";
import type { Production } from "./state";
import type { ColabAllocation } from "@/utils/media/colabPool";
import { decideJev, type JevQuestion, type JevResult } from "@/utils/ai/jev";
import { readColabTimings } from "@/utils/media/timings";
import { machineRates } from "@/utils/media/colab";

const decision = z.object({ reason: z.string().trim().min(1).max(800) });
const schema = z.strictObject({
  machines: decision.extend({ profile: z.literal("parallelSpeech"), renderWorkers: z.literal(1) }),
  reuseDesigns: decision.extend({ mode: z.enum(["new", "matching"]) }),
  characters: z.array(decision.extend({ name: z.string().min(1), views: z.enum(["front", "frontAndQuarter", "full"]) })),
  places: z.array(decision.extend({ name: z.string().min(1), views: z.enum(["front", "multiple"]) })),
  shots: z.array(decision.extend({ shot: z.number().int().positive(), explicit: z.boolean() })),
});
export type ExecutionPlan = z.infer<typeof schema> & { source: string; plannedAt: string; decision: JevResult; questions: Record<string, JevQuestion>; state: unknown };
type StartupEstimate = { machines: number; measuredPreparationSeconds: number | null; preparationUnitsEstimate: number | null; unknown: string[] };
export type StartupPlan = { source: string; profile: ExecutionPlan["machines"]["profile"]; speech: boolean; speechMode: "eager"; reason: string; decision: JevResult; measurements: Awaited<ReturnType<typeof readColabTimings>>; estimates: { profile: ExecutionPlan["machines"]["profile"]; eagerSpeech: StartupEstimate; silent: StartupEstimate }[] };

function estimateStartup(speech: boolean, measurements: StartupPlan["measurements"]): StartupEstimate {
  const allocation = startupAllocation({ profile: "parallelSpeech", speechMode: "eager", speech });
  const groups = new Map<number, string[]>();
  const add = (lane: number, role: string) => groups.set(lane, [...groups.get(lane) ?? [], role]);
  add(0, "text");
  add(1, "sulphur");
  add(1, "image");
  if (speech) add(allocation.speechLane, "drama3Eager");
  const unknown: string[] = [];
  const costs = [...groups].map(([lane, roles]) => {
    const gpu = lane === 0 ? "L4" : "A100";
    const allocations = measurements.filter(item => item.key.endsWith(`/allocation/${gpu}`) && item.medianSeconds !== null).map(item => item.medianSeconds!).sort((a, b) => a - b);
    if (!allocations.length) unknown.push(`allocation/${gpu}`);
    const cost = (role: string, phase: string) => {
      const key = `${role}/${phase}/${gpu}`;
      const sample = measurements.find(item => item.key === key)?.medianSeconds;
      if (sample === undefined || sample === null) { unknown.push(key); return 0; }
      return sample;
    };
    const installers = [0, 0];
    let loads = 0;
    for (const role of roles) {
      const index = installers[0]! <= installers[1]! ? 0 : 1;
      installers[index]! += cost(role, "download");
      if (role !== "sulphur") loads += cost(role, "load");
    }
    return (allocations[Math.floor(allocations.length / 2)] ?? 0) + Math.max(...installers) + loads;
  });
  // Missing observations remain unknown; these estimates exclude unmeasured setup overhead and generation work.
  const seconds = unknown.length ? null : Math.max(...costs);
  const rate = machineRates.L4 + (groups.size - 1) * machineRates.A100;
  return { machines: groups.size, measuredPreparationSeconds: seconds, preparationUnitsEstimate: seconds === null ? null : seconds * rate / 3600, unknown: [...new Set(unknown)] };
}

export async function planStartup(production: Production, signal: AbortSignal): Promise<StartupPlan> {
  const source = createHash("sha256").update(JSON.stringify([production.input, profiles, planStartup.toString(), estimateStartup.toString()])).digest("hex");
  if (production.startupPlan?.source === source) return production.startupPlan;
  const measurements = await readColabTimings();
  const estimates = [{ profile: "parallelSpeech" as const, eagerSpeech: estimateStartup(true, measurements), silent: estimateStartup(false, measurements) }];
  const decision = await decideJev({ request: production.input, instructions: "B3 fixes the models and serving recipe: Qwen text on L4; Qwen-Image base (designs and keyframes) and Sulphur 2 video on A100; original Drama-3 with vLLM eager on an independent A100 when speech is needed. Determine only whether spoken dialogue or narration is required. A vision model on the speech A100 checks every keyframe and clip. Do not change models, sampling, serving runtime or machine sharing." }, {
    speech: { instructions: "Does this requested film need generated spoken dialogue or narration?", criteria: { required: "Spoken dialogue or narration is required; prepare Drama-3 now.", silent: "No generated speech is required; do not install or load Drama-3." } },
  }, signal);
  const speech = decision.answers.speech!.choice === "required";
  return { source, profile: "parallelSpeech", speech, speechMode: "eager", reason: "Fixed B3 recipe: L4 text, A100 images and Sulphur 2 video, and an independent A100 for original Drama-3 with vLLM eager when speech is needed. Spending guards stop the run instead of changing this recipe.", decision, measurements, estimates };
}

export function startupAllocation(startup: Pick<StartupPlan, "profile" | "speech" | "speechMode">): ColabAllocation {
  z.literal("parallelSpeech").parse(startup.profile);
  z.literal("eager").parse(startup.speechMode);
  const speechLane = 2;
  // The vision model that checks keyframes and clips shares the speech A100, idle once the lines are recorded, rather
  // than the video A100, where every check would unload Sulphur.
  const reviewLane = 2;
  return { speechLane, reviewLane, speechMode: "eager", speechRuntime: "vllm", renderWorkers: 1, lanes: [...new Set([0, 1, reviewLane, ...(startup.speech ? [speechLane] : [])])].sort() };
}
const profiles = {
  parallelSpeech: { profile: "parallelSpeech", renderWorkers: 1, description: "3 machines: L4; image/video A100; independent Drama-3 A100. Avoids restarting the expensive speech server during image work." },
} as const;

export const executionSource = (production: Production) => createHash("sha256").update(JSON.stringify([production.input, production.startupPlan?.profile, production.startupPlan?.speechMode, production.startupPlan?.speech, production.plan?.source, executionPrompt.toString(), planExecution.toString(), z.toJSONSchema(schema)])).digest("hex");

function executionPrompt(production: Production) {
  return [
    "Choose this film's executable production workflow using the offered decisions. Preserve the requested picture and sound quality, resolution, duration and all actions; never reduce model sampling steps. Choose the fastest feasible arrangement within the supplied budget rather than always choosing the largest or smallest arrangement.",
    "characters.views selects wardrobe views: front uses a front face close-up and a front outfit image; frontAndQuarter adds three-quarter views of both; full also adds the outfit back view. Every person's views train their identity LoRA and are the references each shot's keyframe is drawn from, which the clip starts from. Select the views the film needs. places.views: front uses one environment image; multiple adds two existing closer views for other framings or spatial continuity.",
    "B3 uses an L4 for text, an A100 for images and Sulphur 2 video and an independent A100 for Drama-3 when speech is needed. Speech never shares the image queue. A vision model on the speech A100 checks every keyframe and clip once all dialogue is recorded, so clips render on one A100. Preserve model precision and sampling steps.",
    `Measured performance: ${JSON.stringify(production.startupPlan!.measurements)}. Null or missing observations are unknown. Preparation, generation and queue phases overlap; do not add all observed durations as a serial total. Use these observations for preparation choices. Existing physical lanes remain stable. Machines remain until delivery or an explicit stop/budget limit.`,
    `Request: ${JSON.stringify(production.input)}`,
    `Authoritative contract: ${JSON.stringify(production.plan)}`,
    `Available assets: ${JSON.stringify(production.assets)}`,
  ].join("\n\n");
}

function readExecutionPlan(input: unknown, production: Production, decision: JevResult, questions: Record<string, JevQuestion>, state: unknown): ExecutionPlan {
  const plan = schema.parse(input);
  const contract = production.plan;
  if (!contract || !production.assets || !production.dub) throw new Error("Compile the production contract and dialogue before planning execution");
  for (const [kind, ids, expected] of [
    ["characters", plan.characters.map(item => item.name), production.assets.characters.map(item => item.name)],
    ["places", plan.places.map(item => item.name), production.assets.places.map(item => item.name)],
  ] as const) if (ids.length !== expected.length || new Set<string | number>(ids).size !== ids.length || expected.some(id => !(ids as readonly (string | number)[]).includes(id))) throw new Error(`Execution plan must cover exactly the ${kind} in the contract`);
  return { ...plan, source: executionSource(production), plannedAt: new Date().toISOString(), decision, questions, state };
}

/** Independent choices share one state; executable resource combinations are offered as complete options. */
export async function planExecution(production: Production, signal: AbortSignal): Promise<ExecutionPlan> {
  if (!production.plan || !production.assets || !production.dub) throw new Error("Compile the production contract before planning execution");
  if (production.startupPlan?.profile !== "parallelSpeech") throw new Error("Startup resource plan conflicts with the compiled film; replan before dispatch");
  const selected = profiles.parallelSpeech;
  const questions: Record<string, JevQuestion> = {
    reuseDesigns: { instructions: "Does the request permit reusing earlier matching character/environment designs, or require fresh designs? This is permission to look for a compatible asset, not a claim that any asset exists. Code still verifies identity, descriptions, source fingerprints and files before reusing anything.", criteria: { new: "The request requires fresh characters/designs or explicitly forbids reusing earlier material.", matching: "Reuse of matching approved designs is permitted by the request; generate new designs when no verified match exists." } },
  };
  production.assets.characters.forEach((person, index) => { questions[`character${index}`] = { instructions: `Which reference views does ${person.name} actually need across the film for identity, clothing and visible orientation? Preserve continuity; do not draw unseen angles without a film-specific reason.`, criteria: { front: "Front identity close-up and front outfit; fixed frontal framing with no turns or complex blocking.", frontAndQuarter: "Front and three-quarter identity/outfit; the film needs angled views or stronger face continuity.", full: "Front/three-quarter identity, and front/three-quarter/back outfit; back views, turns or recurring complex identity need these references." } }; });
  // Explicit shots start from a LUSTIFY v10 frame and render on TenStrip V5; the others keep the Sulphur 2 path.
  production.plan.shots.forEach(shot => { questions[`shot${shot.shot}`] = { instructions: `Does shot ${shot.shot} show sexual activity or exposed genitals at any moment? Judge from its shot-list row, script and contract.`, criteria: { explicit: "The shot shows a sex act, sexual touching of genitals, or exposed genitals; it needs the uncensored still and video models.", clean: "No sexual activity and no exposed genitals in the shot; nudity without visible genitals or sexual acts also counts as clean." } }; });
  production.assets.places.forEach((place, index) => { questions[`place${index}`] = { instructions: `Which environment references does ${place.name} need for the actual camera angles and spatial continuity of this film?`, criteria: { front: "One environment image covers the film's fixed view.", multiple: "The existing front and two closer views are useful for the requested multiple framings or spatial continuity." } }; });
  const state = structuredClone({ instructions: executionPrompt(production), request: production.input, contract: production.plan, rows: production.shots, assets: production.assets });
  const decision = await decideJev(state, questions, signal);
  const why = (name: string) => `Selected ${decision.answers[name]!.choice}; confidence ${decision.answers[name]!.confidence.toFixed(3)}. ${String(questions[name]!.criteria[decision.answers[name]!.choice])}`;
  const plan = {
    machines: { profile: selected.profile, renderWorkers: selected.renderWorkers, reason: selected.description },
    reuseDesigns: { mode: decision.answers.reuseDesigns!.choice, reason: why("reuseDesigns") },
    characters: production.assets.characters.map((person, index) => ({ name: person.name, views: decision.answers[`character${index}`]!.choice, reason: why(`character${index}`) })),
    places: production.assets.places.map((place, index) => ({ name: place.name, views: decision.answers[`place${index}`]!.choice, reason: why(`place${index}`) })),
    shots: production.plan.shots.map(shot => ({ shot: shot.shot, explicit: decision.answers[`shot${shot.shot}`]!.choice === "explicit", reason: why(`shot${shot.shot}`) })),
  };
  return readExecutionPlan(plan, production, decision, questions, state);
}

export function executionAllocation(production: Production): ColabAllocation {
  const plan = production.execution;
  if (!plan || plan.source !== executionSource(production)) throw new Error("Production inputs changed; rebuild the execution plan before dispatch");
  schema.parse({ machines: plan.machines, reuseDesigns: plan.reuseDesigns, characters: plan.characters, places: plan.places, shots: plan.shots });
  const speechLane = 2;
  const reviewLane = 2;
  const lanes = [...new Set([0, 1, reviewLane, ...(production.plan!.voices.length ? [speechLane] : [])])].sort();
  z.literal("eager").parse(production.startupPlan!.speechMode);
  return { speechLane, reviewLane, speechMode: "eager", speechRuntime: "vllm", renderWorkers: plan.machines.renderWorkers, lanes };
}
