// Purpose: Validates native ACP form questions before delegating answers to a request-scoped host.
import { z } from "zod";

/** A native form and its JSON Schema; no answer is inferred by the adapter. */
export interface OpenCodeForm {
  message: string;
  requestedSchema: Record<string, unknown>;
}
/**
 * Request-owned form callback. Return values are validated against the native
 * schema; undefined declines the form. Failures propagate to native execution.
 * Honor the signal so request cleanup can await the callback.
 * @example const answer: OpenCodeAnswer = async (_form, signal) => { signal.throwIfAborted(); return undefined; };
 */
export type OpenCodeAnswer = (
  form: OpenCodeForm,
  signal: AbortSignal,
) => Promise<Record<string, unknown> | undefined>;

/**
 * Answers a native form only when the host supplies a value matching the native
 * schema. Missing hosts, refusals, unsupported schemas and invalid answers cancel
 * the form. Callback failures propagate so native execution cannot invent answers.
 * @example const reply = await answerForm(params, answer, signal);
 */
export async function answerForm(
  params: unknown,
  answer: OpenCodeAnswer | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const form = z
    .looseObject({
      mode: z.literal("form"),
      message: z.string(),
      requestedSchema: z.record(z.string(), z.unknown()),
    })
    .parse(params);
  if (!answer) return { action: "cancel" };
  const content = await answer(form, signal);
  signal.throwIfAborted();
  if (!content) return { action: "cancel" };
  try {
    const schema = z.fromJSONSchema(
      form.requestedSchema as Parameters<typeof z.fromJSONSchema>[0],
    );
    const validated = await schema.safeParseAsync(content);
    return validated.success
      ? { action: "accept", content: validated.data }
      : { action: "cancel" };
  } catch {
    return { action: "cancel" };
  }
}
