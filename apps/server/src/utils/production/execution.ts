import { createHash } from "node:crypto";
import { z } from "zod";
import type { Production } from "./state";
import type { ColabAllocation } from "@/utils/media/colabPool";
import { decideJev, type JevQuestion, type JevResult } from "@/utils/ai/jev";
import { readColabTimings } from "@/utils/media/timings";
import { machineRates } from "@/utils/media/colab";
import { maxClipSeconds } from "@/utils/media/sulphur";

const decision = z.object({ reason: z.string().trim().min(1).max(800) });
const schema = z.strictObject({
  machines: decision.extend({ profile: z.literal("parallelSpeech"), renderWorkers: z.union([z.literal(1), z.literal(2)]) }),
  reuseDesigns: decision.extend({ mode: z.enum(["new", "matching"]) }),
  shots: z.array(decision.extend({ shot: z.number().int().positive(), preparation: z.enum(["reference", "staged"]) })).min(1),
  characters: z.array(decision.extend({ name: z.string().min(1), views: z.enum(["front", "frontAndQuarter", "full"]) })),
  places: z.array(decision.extend({ name: z.string().min(1), views: z.enum(["front", "multiple"]) })),
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
  add(1, "imageTurbo");
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
  const decision = await decideJev({ request: production.input, instructions: "B3 fixes the models and serving recipe: Qwen text on L4; Qwen Turbo/Pose and Sulphur 2 video on A100; original Drama-3 with vLLM eager on an independent A100 when speech is needed. Determine only whether spoken dialogue or narration is required. Do not change models, sampling, serving runtime or machine sharing. Quality reviews are not performed by AI." }, {
    speech: { instructions: "Does this requested film need generated spoken dialogue or narration?", criteria: { required: "Spoken dialogue or narration is required; prepare Drama-3 now.", silent: "No generated speech is required; do not install or load Drama-3." } },
  }, signal);
  const speech = decision.answers.speech!.choice === "required";
  return { source, profile: "parallelSpeech", speech, speechMode: "eager", reason: "Fixed B3 recipe: L4 text, A100 images and Sulphur 2 video, and an independent A100 for original Drama-3 with vLLM eager when speech is needed. Spending guards stop the run instead of changing this recipe.", decision, measurements, estimates };
}

export function startupAllocation(startup: Pick<StartupPlan, "profile" | "speech" | "speechMode">): ColabAllocation {
  z.literal("parallelSpeech").parse(startup.profile);
  z.literal("eager").parse(startup.speechMode);
  const speechLane = 2;
  const reviewLane = 1;
  return { speechLane, reviewLane, speechMode: "eager", speechRuntime: "vllm", renderWorkers: 1, lanes: [...new Set([0, 1, reviewLane, ...(startup.speech ? [speechLane] : [])])].sort() };
}
const profiles = {
  parallelSpeech: { profile: "parallelSpeech", renderWorkers: 1, description: "3 machines: L4; image/video A100; independent Drama-3 A100. Avoids restarting the expensive speech server during image work." },
  parallelSpeechTwo: { profile: "parallelSpeech", renderWorkers: 2, description: "3 machines, two video renderers after speech is complete; For multiple independent shots." },
} as const;

export const executionSource = (production: Production) => createHash("sha256").update(JSON.stringify([production.input, production.startupPlan?.profile, production.startupPlan?.speechMode, production.startupPlan?.speech, production.plan?.source, executionPrompt.toString(), planExecution.toString(), z.toJSONSchema(schema)])).digest("hex");

function executionPrompt(production: Production) {
  return [
    "Choose this film's executable production workflow using the offered decisions. Preserve the requested picture and sound quality, resolution, duration and all actions; never reduce model sampling steps. Choose the fastest feasible arrangement within the supplied budget rather than always choosing the largest or smallest arrangement.",
    `shots.preparation: reference generates an identity-conditioned opening composition, which the clip starts from with nothing to follow but its prompt. Use it for a fixed camera, a stable opening pose, and only facial expression or speech, with no spatial interactions, entrances, exits or body movement requiring choreography. staged uses the full 3D blocking, camera and body-motion pipeline: the clip starts from a keyframe drawn on the previs and follows the previs depth video. Use staged for spatial actions, props in motion, camera movement, actor interactions or uncertain staging. A reference shot must have at most one actor and last at most ${maxClipSeconds} seconds. Generated speech, pronunciation, video and lip synchronization are not AI-reviewed.`,
    "characters.views selects wardrobe views: front uses a front face close-up and a front outfit image; frontAndQuarter adds three-quarter views of both; full also adds the outfit back view. The face close-ups train a person's identity LoRA when they appear in enough shots; the outfit views are posed into each shot's keyframe. Select the views the film needs. places.views: front uses one environment image; multiple adds two existing closer views for other framings or spatial continuity.",
    "B3 uses an L4 for text, an A100 for images and Sulphur 2 video and an independent A100 for Drama-3 when speech is needed. Speech never shares the image queue. No quality-review model is installed. renderWorkers=2 can reuse the speech A100 after all dialogue is recorded, only for multiple independent shots. Preserve model precision and sampling steps.",
    `Measured performance: ${JSON.stringify(production.startupPlan!.measurements)}. Null or missing observations are unknown. Preparation, generation and queue phases overlap; do not add all observed durations as a serial total. Use these observations for render-worker and preparation choices. Existing physical lanes remain stable; a second renderer may reuse the speech lane only after all dialogue is complete. Machines remain until delivery or an explicit stop/budget limit.`,
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
    ["shots", plan.shots.map(item => item.shot), contract.shots.map(item => item.shot)],
    ["characters", plan.characters.map(item => item.name), production.assets.characters.map(item => item.name)],
    ["places", plan.places.map(item => item.name), production.assets.places.map(item => item.name)],
  ] as const) if (ids.length !== expected.length || new Set<string | number>(ids).size !== ids.length || expected.some(id => !(ids as readonly (string | number)[]).includes(id))) throw new Error(`Execution plan must cover exactly the ${kind} in the contract`);
  if (plan.machines.renderWorkers === 2 && (plan.machines.profile !== "parallelSpeech" || plan.shots.length < 2)) throw new Error("Two render workers require an independent second A100 and at least two shots");
  for (const shot of plan.shots.filter(item => item.preparation === "reference")) {
    const actors = contract.shots.find(item => item.shot === shot.shot)!.actors;
    if (actors.length > 1 || actors.length > 0 && production.dub.shots.find(item => item.shot === shot.shot)!.seconds > maxClipSeconds) throw new Error(`Shot ${shot.shot}: reference preparation does not support this cast or duration`);
  }
  return { ...plan, source: executionSource(production), plannedAt: new Date().toISOString(), decision, questions, state };
}

/** Independent choices share one state; executable resource combinations are offered as complete options. */
export async function planExecution(production: Production, signal: AbortSignal): Promise<ExecutionPlan> {
  if (!production.plan || !production.assets || !production.dub) throw new Error("Compile the production contract before planning execution");
  const available = Object.entries(profiles).filter(([name, value]) => value.profile === production.startupPlan?.profile && (!name.endsWith("Two") || production.plan!.shots.length > 1));
  const questions: Record<string, JevQuestion> = {
    ...available.length > 1 ? { machines: { instructions: "Choose the fastest feasible machine schedule for this film within its budget, accounting for cold setup, heavyweight reloads, dependent preparation and parallel shot work. Do not automatically choose the most or least machines. Compare the actual task with the supplied measured costs.", criteria: Object.fromEntries(available.map(([name, value]) => [name, value.description])) } } : {},
    reuseDesigns: { instructions: "Does the request permit reusing earlier matching character/environment designs, or require fresh designs? This is permission to look for a compatible asset, not a claim that any asset exists. Code still verifies identity, descriptions, source fingerprints and files before reusing anything.", criteria: { new: "The request requires fresh characters/designs or explicitly forbids reusing earlier material.", matching: "Reuse of matching approved designs is permitted by the request; generate new designs when no verified match exists." } },
  };
  const reference = "Generate an identity-conditioned opening still the clip starts from; no 3D simulation. Appropriate only for a fixed camera and stable pose with speech/facial expression, without entrances, exits, prop movement, body choreography or spatial interaction.";
  const staged = "Use full 3D camera/body blocking, proxy animation and pose transfer to preserve spatial actions, movement, camera changes or uncertain staging.";
  for (const shot of production.plan.shots) if (shot.actors.length === 1 && production.dub.shots.find(item => item.shot === shot.shot)!.seconds <= maxClipSeconds) questions[`shot${shot.shot}`] = { instructions: `Choose preparation for shot ${shot.shot} from its complete row and contract. Preserve every requested visible action and camera behavior. Use staged when spatial guidance is needed or the shot's staging is uncertain.`, criteria: { reference, staged } };
  production.assets.characters.forEach((person, index) => { questions[`character${index}`] = { instructions: `Which reference views does ${person.name} actually need across the film for identity, clothing and visible orientation? Preserve continuity; do not draw unseen angles without a film-specific reason.`, criteria: { front: "Front identity close-up and front outfit; fixed frontal framing with no turns or complex blocking.", frontAndQuarter: "Front and three-quarter identity/outfit; the film needs angled views or stronger face continuity.", full: "Front/three-quarter identity, and front/three-quarter/back outfit; back views, turns or recurring complex identity need these references." } }; });
  production.assets.places.forEach((place, index) => { questions[`place${index}`] = { instructions: `Which environment references does ${place.name} need for the actual camera angles and spatial continuity of this film?`, criteria: { front: "One environment image covers the film's fixed view.", multiple: "The existing front and two closer views are useful for the requested multiple framings or spatial continuity." } }; });
  const state = structuredClone({ instructions: executionPrompt(production), request: production.input, contract: production.plan, rows: production.shots, assets: production.assets });
  const decision = await decideJev(state, questions, signal);
  const selected = available.find(([name]) => name === decision.answers.machines?.choice)?.[1] ?? available[0]?.[1];
  if (!selected) throw new Error("Startup resource plan conflicts with the compiled film; replan before dispatch");
  const why = (name: string) => `Selected ${decision.answers[name]!.choice}; confidence ${decision.answers[name]!.confidence.toFixed(3)}. ${String(questions[name]!.criteria[decision.answers[name]!.choice])}`;
  const plan = {
    machines: { profile: selected.profile, renderWorkers: selected.renderWorkers, reason: (decision.answers.machines ? why("machines") : production.startupPlan!.reason).slice(0, 800) },
    reuseDesigns: { mode: decision.answers.reuseDesigns!.choice, reason: why("reuseDesigns") },
    shots: production.plan.shots.map(shot => ({ shot: shot.shot, preparation: !shot.actors.length ? "reference" : decision.answers[`shot${shot.shot}`]?.choice ?? "staged", reason: !shot.actors.length ? "No performing characters: use an opening reference; preserve product and camera motion in the video prompt rather than inventing humanoid proxies." : questions[`shot${shot.shot}`] ? why(`shot${shot.shot}`) : "Platform constraints require staged preparation for this cast or duration." })),
    characters: production.assets.characters.map((person, index) => ({ name: person.name, views: decision.answers[`character${index}`]!.choice, reason: why(`character${index}`) })),
    places: production.assets.places.map((place, index) => ({ name: place.name, views: decision.answers[`place${index}`]!.choice, reason: why(`place${index}`) })),
  };
  return readExecutionPlan(plan, production, decision, questions, state);
}

export function executionAllocation(production: Production): ColabAllocation {
  const plan = production.execution;
  if (!plan || plan.source !== executionSource(production)) throw new Error("Production inputs changed; rebuild the execution plan before dispatch");
  schema.parse({ machines: plan.machines, reuseDesigns: plan.reuseDesigns, shots: plan.shots, characters: plan.characters, places: plan.places });
  const speechLane = 2;
  const reviewLane = 1;
  const lanes = [...new Set([0, 1, reviewLane, ...(production.plan!.voices.length || plan.machines.renderWorkers === 2 ? [speechLane] : [])])].sort();
  z.literal("eager").parse(production.startupPlan!.speechMode);
  return { speechLane, reviewLane, speechMode: "eager", speechRuntime: "vllm", renderWorkers: plan.machines.renderWorkers, lanes };
}
