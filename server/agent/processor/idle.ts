// Purpose: Times provider silence while allowing tools and permissions to finish.

import { Effect, Stream } from "effect";
import { StreamStalled } from "./errors";

/**
 * Fails a silent provider pull after stallMs of idle time. Downstream processing
 * is outside the timer; tool or permission work disarms it while the same pull
 * remains pending. Every source event starts a fresh idle window.
 *
 * ```text
 * pending provider pull  ---------------------------------------------------->
 * idle                  [ timer ]
 * isTimeoutSuspended            [ wait for timeout state change ]
 * idle                                                          [ timer ]
 *                                                               ^ fresh window
 * ```
 *
 * isTimeoutSuspended reads whether the idle deadline should be suspended. When
 * that state changes outside stream events, timeoutStateChanged must wake the
 * watchdog once; a sliding Queue of capacity one supplies a coalesced signal
 * without polling. Effect interrupts the losing race and the consuming stream
 * owns source cleanup.
 *
 * @example
 * const activity = yield* Queue.sliding<void>(1);
 * const guarded = source.pipe(
 *   withIdleTimeout(isTimeoutSuspended, 60_000, Queue.take(activity)),
 * );
 * // After entering or leaving an out-of-stream permission callback:
 * yield* Queue.offer(activity, undefined);
 */
export function withIdleTimeout(
  isTimeoutSuspended: () => boolean,
  stallMs: number,
  timeoutStateChanged: Effect.Effect<void> = Effect.never,
) {
  const watchdog = Effect.suspend(() =>
    isTimeoutSuspended()
      ? timeoutStateChanged
      : Effect.timeoutOrElse(timeoutStateChanged, {
          duration: stallMs,
          orElse: () =>
            isTimeoutSuspended()
              ? Effect.void
              : Effect.fail(new StreamStalled({ stallMs })),
        }),
  ).pipe(Effect.forever);

  return <A, E, R>(
    source: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E | StreamStalled, R> =>
    Stream.transformPull(source, (pull) =>
      Effect.succeed(Effect.raceFirst(pull, watchdog)),
    );
}
