// Purpose: Runs lazy workflow effects concurrently with ordered per-item outcomes.

import { Workflow } from "@openchart/server/agent/workflow";
import { PublishTrace } from "@openchart/server/agent/workflow/tracing";
import { Cause, Effect, Exit, Result } from "effect";

/** Stable per-item outcomes; interruption and defects never become item failures. */
export type Outcome<A> =
  | { readonly status: "success"; readonly value: A }
  | {
      readonly status: "error";
      readonly error: { readonly name: string; readonly message: string };
    };

/**
 * Executes lazy Effects concurrently, preserves input order, and isolates expected
 * failures. The host settings supply the concurrency limit. Root cancellation
 * interrupts and joins all active items. An automatic span parents the child spans;
 * trace publication failures propagate.
 * @example
 * const answers = yield* parallel([agent(firstPrompt), agent(secondPrompt)]);
 */
export const parallel = <A, E, R>(
  effects: readonly Effect.Effect<A, E, R>[],
): Effect.Effect<Outcome<A>[], unknown, Workflow.Service | R> =>
  Effect.gen(function* () {
    const host = yield* Workflow.Service;
    yield* Effect.flatten(PublishTrace);
    const results = yield* Effect.all(effects, {
      concurrency: host.settings.concurrency,
      mode: "result",
    });
    return results.map(
      Result.match({
        onSuccess: (value: A): Outcome<A> => ({ status: "success", value }),
        onFailure: (error: E): Outcome<A> => ({
          status: "error",
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      }),
    );
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? Effect.annotateCurrentSpan("openchart.cancelled", true)
        : Effect.void,
    ),
    Effect.withSpan("Workflow.parallel", {
      attributes: { "openchart.label": "parallel" },
    }),
    // Publish after withSpan has ended the parent, including cancellation.
    Effect.onExit(() => Effect.flatten(PublishTrace)),
  );
