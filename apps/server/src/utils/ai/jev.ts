import { z } from "zod";
import { resolveEnvReference } from "@/utils/conf/env";

export const jevModel = "jev-1.14.0";
export type JevQuestion = { instructions: unknown; criteria: Record<string, unknown> };
const probability = z.number().finite().min(0).max(1);
const answerSchema = z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: z.record(z.string(), probability) });
const responseSchema = z.object({ model: z.literal(jevModel), answers: z.record(z.string(), answerSchema), usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }) });
export type JevResult = z.infer<typeof responseSchema> & { seconds: number };
export async function requireJevKey() {
  const key = await resolveEnvReference("env:PERSONAL_JEV_API_KEY");
  if (typeof key !== "string" || !key.trim()) throw new Error("Set PERSONAL_JEV_API_KEY in the Toonflow process environment or ~/.env");
  return key.trim();
}

/** Jev selects resources and workflow options; it does not review generated content. */
export async function decideJev(state: unknown, questions: Record<string, JevQuestion>, signal: AbortSignal): Promise<JevResult> {
  const key = await requireJevKey();
  const names = Object.keys(questions);
  if (!names.length || names.some(name => !/^[a-z][a-zA-Z0-9]{0,127}$/.test(name))) throw new Error("Jev needs named, bounded questions");
  for (const question of Object.values(questions)) if (Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255) throw new Error("Jev Choice needs 2–255 available options");
  const body = JSON.stringify({ model: jevModel, state, questions: Object.fromEntries(Object.entries(questions).map(([name, question]) => [name, { type: "choice", ...question }])) });
  if (Buffer.byteLength(body) > 32 * 1024 * 1024) throw new Error("Jev request exceeds 32 MiB; split the evidence");
  const started = performance.now();
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body,
  });
  // Provider errors can echo inputs; do not log request bodies, credentials or media.
  if (!response.ok) throw new Error(`Jev request failed: HTTP ${response.status}, request ${response.headers.get("x-request-id") ?? "unknown"}`);
  const result = responseSchema.parse(await response.json());
  if (Object.keys(result.answers).length !== names.length) throw new Error("Jev returned a different question set");
  for (const name of names) {
    const answer = result.answers[name];
    const options = Object.keys(questions[name]!.criteria);
    if (!answer || !options.includes(answer.choice) || Object.keys(answer.probabilities).length !== options.length || options.some(option => !(option in answer.probabilities))) throw new Error(`Jev returned an unavailable option for ${name}`);
    const total = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
    const selected = answer.probabilities[answer.choice]!;
    const maximum = Math.max(...Object.values(answer.probabilities));
    // The live API rounds probabilities to two decimals; retain them and allow their accumulated rounding error.
    if (total <= 0 || Math.abs(total - 1) > options.length * 0.005 + Number.EPSILON || selected < maximum) throw new Error(`Invalid Jev distribution for ${name}: sum=${total}, selected=${selected}, maximum=${maximum}`);
  }
  return { ...result, seconds: (performance.now() - started) / 1000 };
}
