// Purpose: Defines the session runner and persists claimed Run outcomes after prompt execution.

export * as SessionRunner from "./runner";

import { Cause, Context, Effect, Layer } from "effect";
import { Prompt } from "@openchart/server/agent/prompt/prompt";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import type { Failed } from "@openchart/server/agent/prompt/errors";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Errors exposed by the orchestration-only runner. */
export type RunError = SqlError | EffectDrizzleQueryError | Failed;

/** Runs durable work belonging to one session. */
export interface Interface {
  /**
   * Drains eligible durable work for one session.
   *
   * @param input - Session whose durable queue should be drained.
   * @returns An Effect that settles after the current drain finishes.
   *
   * @example
   * ```ts
   * yield* runner.run({sessionID: 'session-1'});
   * ```
   */
  readonly run: (input: {
    readonly sessionID: string;
  }) => Effect.Effect<
    void,
    RunError,
    Effect.Services<ReturnType<Prompt.Interface["execute"]>>
  >;
}

/** Session runner supplied to the process-local execution coordinator. */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/SessionRunner",
) {}

/**
 * Orchestration-only runner backed by `agent_run` and Prompt.Service.
 *
 * @example
 * ```ts
 * const runnerLayer = layer.pipe(
 *   Layer.provide(Prompt.layer),
 *   Layer.provide(databaseLayer),
 * );
 * ```
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* AgentRunStore.Service;
    const prompt = yield* Prompt.Service;

    const run = Effect.fn("SessionRunner.run")(
      (input: { readonly sessionID: string }) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            while (true) {
              // Observe cancellation before claiming; claim and terminal writes
              // must finish, while prompt execution remains interruptible.
              yield* restore(Effect.void);
              const claimed = yield* store.claim(input.sessionID);
              if (!claimed) return;

              yield* restore(
                Effect.suspend(() => prompt.execute(claimed)),
              ).pipe(
                Effect.matchCauseEffect({
                  onSuccess: () => store.complete(claimed.id),
                  onFailure: (cause) =>
                    Effect.andThen(
                      Cause.hasInterruptsOnly(cause)
                        ? store.stop(claimed.id)
                        : store.fail(claimed.id),
                      Cause.hasDies(cause) || Cause.hasInterrupts(cause)
                        ? Effect.failCause(cause)
                        : Effect.logError(cause),
                    ),
                }),
              );
            }
          }),
        ),
    );

    return Service.of({ run });
  }),
);
