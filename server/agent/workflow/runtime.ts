// Purpose: Runs trusted Effect workflows with immutable inputs and bounded child execution.

import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { WorkflowPart } from "@openchart/server/agent/contracts/part";
import { Effect, Schema, Semaphore } from "effect";
import { Workflow } from "./workflow";
import { withWorkflowTracing } from "./tracing";
import { immutable } from "./authoring/shared/immutable";

/** Same invocation envelope for deterministic Parts and model tool calls. */
export const Invocation = Schema.Struct({
  workflow: WorkflowPart.fields.workflow,
  args: WorkflowPart.fields.args,
});

/** Immutable accepted prompt available to the authored control program. */
export interface InvocationContext {
  readonly parentPrompt: AgentPromptInput;
}

/** Trusted program with its sole input decoder; the source owns its identity. */
export interface Definition {
  readonly kind: "workflow";
  readonly description: string;
  /**
   * Decodes arguments and executes the program using the installed Workflow.Service.
   * @example
   * yield* definition.execute(args, {parentPrompt}, () => Effect.void);
   */
  readonly execute: (
    args: Schema.JsonObject,
    context: InvocationContext,
    onPrepared: (args: Schema.JsonObject) => Effect.Effect<void, unknown>,
  ) => Effect.Effect<Schema.Json, unknown, Workflow.Service>;
}

/**
 * Runs one program with the host's child limit enforced even without parallel().
 * Each invocation owns its semaphore and locally wraps the same Workflow.Service.
 * Callers must enter through run before executing an authored program.
 * Expected child failures may be handled by the program; defects and cancellation
 * propagate. Effect joins interrupted children before this invocation settles.
 * onChildSession commits each direct child link before its trace and execution;
 * continuations report the same ID again, so the sink must append idempotently.
 * @example
 * const result = yield* run(definition, args);
 */
export const run = Effect.fn("Workflow.run")(function* (
  definition: Definition,
  args: Schema.JsonObject,
  onPrepared: (args: Schema.JsonObject) => Effect.Effect<void, unknown> = () =>
    Effect.void,
  onTrace: (trace: Schema.JsonObject) => Effect.Effect<void, unknown> = () =>
    Effect.void,
  onChildSession: (sessionId: string) => Effect.Effect<void, unknown> = () =>
    Effect.void,
) {
  const host = yield* Workflow.Service;
  const concurrency = host.settings.concurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    return yield* Effect.die(
      new Error("Workflow concurrency must be a positive integer"),
    );
  const semaphore = yield* Semaphore.make(concurrency);
  return yield* definition
    .execute(
      immutable(args),
      immutable({ parentPrompt: host.parentPrompt }),
      onPrepared,
    )
    .pipe(
      Effect.provideService(Workflow.Service, {
        ...host,
        agent: (input, onSession, options) =>
          semaphore.withPermit(
            host.agent(
              input,
              (sessionId) =>
                onChildSession(sessionId).pipe(
                  Effect.andThen(onSession(sessionId)),
                ),
              options,
            ),
          ),
      }),
      (program) => withWorkflowTracing(program, onTrace),
    );
});
