// Purpose: Creates or continues a child Session and publishes one live span per call.

import { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Workflow, type AgentResult } from "@openchart/server/agent/workflow";
import { InvalidOutput } from "@openchart/server/agent/workflow/errors";
import { PublishTrace } from "@openchart/server/agent/workflow/tracing";
import { Cause, Effect, Exit, Schema } from "effect";
import { immutable } from "./shared/immutable";
import { outputSchema } from "./shared/output-schema";

interface AgentOptions {
  readonly label?: string;
  readonly sessionId?: string;
}

type AgentEffect<A = string> = Effect.Effect<
  AgentResult<A>,
  unknown,
  Workflow.Service
>;

/**
 * Creates a child Session, or appends this prompt to an owned child via sessionId.
 * New children never copy parent history; continuations retain their own history.
 * The host supplies execution and cancellation; no Promise bridge is involved.
 * The optional label names the trace step; otherwise use the first prompt line or agent name.
 * With schema, output is decoded JSON; otherwise output is text. Schema applies
 * only to this call. Invalid output fails with its sessionId and is never retried.
 * @example
 * const child = yield* agent({agent: 'analyst', model, parts: [{type: 'text', text: 'Research AAPL'}]}, {label: 'research'});
 * const reply = yield* agent(nextPrompt, {sessionId: child.sessionId, label: 'follow-up'});
 * const review = yield* agent(prompt, {schema: Schema.Struct({passed: Schema.Boolean})});
 */
export function agent<A extends Schema.Json>(
  input: AgentPromptInput,
  options: AgentOptions & {
    readonly schema: Schema.Codec<A, Schema.Json>;
  },
): AgentEffect<A>;

export function agent(
  input: AgentPromptInput,
  options?: AgentOptions & { readonly schema?: undefined },
): AgentEffect;

export function agent(
  input: AgentPromptInput,
  options?: AgentOptions & {
    readonly schema?: Schema.Codec<Schema.Json>;
  },
): AgentEffect<Schema.Json> {
  return invokeAgent(input, options);
}

const invokeAgent = Effect.fnUntraced(function* (
  input: AgentPromptInput,
  options?: AgentOptions & {
    readonly schema?: Schema.Codec<Schema.Json, Schema.Json>;
  },
) {
  const host = yield* Workflow.Service;
  const jsonSchema = options?.schema && (yield* outputSchema(options.schema));
  const parsed = yield* Schema.decodeUnknownEffect(AgentPromptInput)(input);
  const publish = yield* PublishTrace;
  return yield* Effect.useSpan(
    "Workflow.agent",
    { attributes: agentSpanAttributes(parsed, options?.label) },
    (span) =>
      host
        .agent(
          immutable(parsed),
          (sessionId) => {
            span.attribute("openchart.session.id", sessionId);
            return publish;
          },
          { sessionId: options?.sessionId, outputSchema: jsonSchema },
        )
        .pipe(
          Effect.flatMap((result) =>
            decodeAgentResult(result, options?.schema),
          ),
          Effect.withParentSpan(span),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
                span.attribute("openchart.cancelled", true);
              }
            }),
          ),
        ),
  ).pipe(
    // useSpan ends the SDK span first, including on failure/interruption. Commit
    // that final snapshot before the tool can finish and close progress admission.
    Effect.onExit(() => publish),
  );
});

function agentSpanAttributes(input: AgentPromptInput, label?: string) {
  return {
    "openchart.agent": input.agent,
    "openchart.label":
      label ??
      input.parts.find((part) => part.type === "text")?.text.split("\n")[0] ??
      input.agent,
    "gen_ai.request.model": input.model.modelID,
  };
}

const decodeAgentResult = Effect.fnUntraced(function* (
  result: AgentResult,
  schema?: Schema.Codec<Schema.Json, Schema.Json>,
) {
  if (!schema) return result;
  const output = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(schema),
    { onExcessProperty: "error" },
  )(result.output).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidOutput({
          sessionId: result.sessionId,
          message: cause.message,
          cause,
        }),
    ),
  );
  return { sessionId: result.sessionId, output };
});
