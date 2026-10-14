// Purpose: Forks the scheduler loop and owns its application-scoped shutdown.

import { Cause, Effect, Layer } from "effect";

import { Scheduler } from "./scheduler";

/**
 * Starts the scheduler once when this Layer is built.
 *
 * The fork belongs to this Layer's scope, survives individual requests, and
 * finishes interruption cleanup before its service dependencies are released.
 * Application runtime composes this Layer alongside other service Layers.
 * Unexpected scheduler defects are logged; normal shutdown is not an error.
 *
 * @example
 * ```ts
 * const runtime = ManagedRuntime.make(
 *   layer.pipe(Layer.provideMerge(applicationServices)),
 * );
 * await runtime.context();
 * await runtime.dispose();
 * ```
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service;
    yield* scheduler.runLoop().pipe(
      Effect.tapCauseIf(Cause.hasDies, (cause) =>
        Effect.logError("Scheduler background run failed", cause),
      ),
      Effect.forkScoped,
    );
  }),
);
