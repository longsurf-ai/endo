// Purpose: Defines process-local session execution control and connects its coordinator to SessionRunner.

export * as SessionExecution from "./execution";

import { Context, Effect, Layer } from "effect";
import { SessionRunCoordinator } from "./coordinator";
import { SessionRunner } from "@openchart/server/agent/session/runner";

/** Process-local control over serialized session execution. */
export interface Interface {
  /** Snapshots sessions with execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<string>>;
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: string) => Effect.Effect<void>;
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (sessionID: string) => Effect.Effect<void>;
}

/** Routes session execution through the process-local coordinator. */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/SessionExecution",
) {}

/**
 * Process-local implementation of {@link Service}.
 *
 * @example
 * ```ts
 * const executionLayer = layer.pipe(Layer.provide(runnerLayer));
 * ```
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runner = yield* SessionRunner.Service;
    const coordinator = yield* SessionRunCoordinator.make({
      drain: (sessionID: string) => runner.run({ sessionID }),
    });

    return coordinator;
  }),
);
