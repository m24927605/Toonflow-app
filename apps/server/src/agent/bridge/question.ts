import { z } from "zod";
import type { QuestionAnswer, QuestionContext, QuestionRequest } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";

type PendingQuestion = { cwd: string; request: QuestionRequest; cancel(): void; finish(result: QuestionAnswer | Error): void };

// ACT: Questions live with the current stream with no answer timeout; they are
// canceled on disconnect or stop, and multi-process setups need a shared channel.
const pendingQuestions = new Map<string, PendingQuestion>();

export function createQuestionContext(cwd: string, send: (event: Extract<AgentEvent, { type: "question" }>) => void, onCancel?: () => void) {
  const activeQuestions = new Set<string>();
  let disposed = false;
  const context: QuestionContext = {
    async ask(toolCallId, request, signal) {
      if (disposed) throw new Error("The conversation to which the question belongs has ended");
      signal?.throwIfAborted();
      const callId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const finish = (result: QuestionAnswer | Error) => {
          if (!pendingQuestions.delete(callId)) return;
          activeQuestions.delete(callId);
          signal?.removeEventListener("abort", abort);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const abort = () => finish(new Error("Question has been canceled"));
        pendingQuestions.set(callId, { cwd, request, finish, cancel() { onCancel?.(); abort(); } });
        activeQuestions.add(callId);
        signal?.addEventListener("abort", abort, { once: true });
        try { send({ ...request, type: "question", toolCallId, callId }); }
        catch (error) { finish(error instanceof Error ? error : new Error("Failed to send question")); }
      });
    },
  };
  return {
    context,
    dispose() {
      disposed = true;
      for (const callId of activeQuestions) pendingQuestions.get(callId)?.finish(new Error("The conversation to which the question belongs has ended"));
    },
  };
}

export function answerQuestion(cwd: string, callId: string, response: { answer?: string; values?: unknown; cancelled?: boolean; skipped?: boolean }) {
  const pending = pendingQuestions.get(callId);
  if (!pending || pending.cwd !== cwd) throw Object.assign(new Error("The question does not exist or has ended"), { status: 404 });
  if (response.cancelled) {
    pending.cancel();
    return;
  }
  if (response.skipped) {
    const result: QuestionAnswer = { answer: "The user skipped this question", skipped: true };
    pending.finish(result);
    return result;
  }
  const fields = pending.request.fields;
  let result: QuestionAnswer;
  if (fields?.length) {
    const shape = Object.fromEntries(fields.map(field => {
      let schema: z.ZodType = z.string().trim().max(8000);
      if (field.type === "inputNumber") schema = z.number();
      else if (field.type === "switch") schema = z.boolean();
      else if (["radio", "select"].includes(field.type)) schema = z.enum(field.options!);
      else if (field.type === "checkbox") schema = z.array(z.enum(field.options!)).max(field.options!.length)
        .refine(value => new Set(value).size === value.length, "Options cannot be repeated");
      if (field.required) schema = schema.refine(value => value !== "" && (!Array.isArray(value) || value.length > 0), `${field.title} cannot be empty`);
      else schema = z.preprocess(value => value === "" || value === null ? undefined : value, schema.optional());
      return [field.field, schema];
    }));
    const parsed = z.strictObject(shape).safeParse(response.values);
    if (!parsed.success) throw Object.assign(new Error("Please fill in the form as required"), { status: 400 });
    const values = parsed.data as NonNullable<QuestionAnswer["values"]>;
    const answer = fields.filter(field => values[field.field] !== undefined).map(field => {
      const value = values[field.field];
      return `${field.title}: ${Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? value ? "Yes" : "No" : value}`;
    }).join("\n");
    result = { answer: answer || "Optional options not filled in", values };
  } else {
    const parsed = z.string().trim().min(1).max(8000).safeParse(response.answer);
    if (!parsed.success) throw Object.assign(new Error("Please enter your answer"), { status: 400 });
    result = { answer: parsed.data };
  }
  pending.finish(result);
  return result;
}
