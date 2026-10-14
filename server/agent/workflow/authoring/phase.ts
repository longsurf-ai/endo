// Purpose: Names an execution scope using the workflow's existing trace lifecycle.

import { PublishTrace } from "@openchart/server/agent/workflow/tracing";
import { Cause, Effect, Exit } from "effect";

/**
 * Groups an Effect and its nested calls into a named phase, returning its result.
 * Starts only when executed; nested and concurrent phases inherit Effect parentage.
 * Failures and cancellation propagate after cleanup and final trace publication.
 * Handled child failures do not fail the phase. Trace publication can also fail.
 * @example
 * const answers = yield* phase("Research", parallel([agent(first), agent(second)]));
 * const result = yield* phase("Review", Effect.gen(function* () {
 *   const draft = yield* agent(draftPrompt);
 *   return yield* agent(reviewPrompt(draft));
 * }));
 */
export const phase = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, unknown, R> =>
  Effect.flatten(PublishTrace).pipe(
    Effect.andThen(effect),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        ? Effect.annotateCurrentSpan("openchart.cancelled", true)
        : Effect.void,
    ),
    Effect.withSpan("Workflow.phase", {
      attributes: { "openchart.label": name },
    }),
    Effect.onExit(() => Effect.flatten(PublishTrace)),
  );
