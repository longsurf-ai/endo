// Purpose: Bridges request-owned Effect callbacks to SDK Promises and reports defects to the stream.

import { Cause, Deferred, Effect, FiberSet } from "effect";

/** Request-local callback runtime and its defect notification. */
export interface CallbackRuntime<R = never> {
  /**
   * Create one runtime per request. Route SDK callbacks through `runPromise`
   * and attach this signal to the source stream with `Stream.interruptWhen`.
   * Keep both in the same request Scope so stream failure triggers cleanup.
   * Merely calling `runPromise` does not wire this signal to the stream.
   * Other requests are unaffected, even if the SDK catches the rejection.
   *
   * @example
   * const request = Effect.scoped(Effect.gen(function* () {
   *   const callbackRuntime = yield* createCallbackRuntime();
   *   const source = openModelStream({
   *     execute: (signal: AbortSignal) =>
   *       callbackRuntime.runPromise(toolEffect, signal),
   *   });
   *   yield* Stream.runDrain(source.pipe(
   *     Stream.interruptWhen(callbackRuntime.defect),
   *   ));
   * }));
   */
  readonly defect: Effect.Effect<never>;

  /**
   * Lets the SDK call our Effect code and await a Promise. The callback uses
   * this request's services and stops when its signal aborts or the request closes.
   *
   * ```text
   * SDK calls runPromise(effect, signal)
   *   |
   *   +-- Run the Effect under this request's lifetime
   *         |
   *         +-- Success                       -> resolve the SDK Promise
   *         +-- Expected error or interruption -> reject the SDK Promise
   *         +-- Defect                        -> reject the SDK Promise
   *                                           + notify the outer stream
   * ```
   *
   * The last path stops the stream even if the SDK catches the rejection.
   * The SDK handles cancellation rejections; they do not notify the outer stream.
   * @example
   * callbackRuntime.runPromise(Effect.succeed(result), abortSignal);
   */
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, R>,
    signal: AbortSignal,
  ) => Promise<A>;
}

/**
 * Creates one callback bridge per model request, reporting callback defects
 * separately from the SDK's Promise rejection channel. The request Scope
 * interrupts active callbacks and waits for their finalizers before closing.
 * @example
 * const callbackRuntime = yield* createCallbackRuntime();
 * const stream = source.pipe(Stream.interruptWhen(callbackRuntime.defect));
 */
export const createCallbackRuntime = Effect.fn("LLM.createCallbackRuntime")(
  function* <R = never>() {
    const fork = yield* FiberSet.makeRuntimePromise<R>();

    const defect = yield* Deferred.make<never>();

    return {
      defect: Deferred.await(defect),
      runPromise: <A, E>(effect: Effect.Effect<A, E, R>, signal: AbortSignal) =>
        fork(
          // The runner starts synchronously. Yield so it installs cancellation
          // and registers the fiber before callback code can run or close the
          // request Scope.
          Effect.yieldNow.pipe(
            Effect.andThen(effect),
            Effect.onErrorIf(Cause.hasDies, (cause) => {
              const defects = cause.reasons.filter(Cause.isDieReason);
              return Deferred.failCause(defect, Cause.fromReasons(defects));
            }),
          ),
          { signal },
        ),
    } satisfies CallbackRuntime<R>;
  },
);
