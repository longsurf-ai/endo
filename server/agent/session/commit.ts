// Purpose: Commits one Session or transcript operation before publishing its live changes.

import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Effect } from "effect";

type Tx = Parameters<Parameters<Database.Client["transaction"]>[0]>[0];

/**
 * Runs one outer transaction, then publishes its successful result.
 *
 * Call outside any existing transaction. Compose atomic writes through Stores
 * inside the callback. This boundary is a caller convention. Writes
 * remain interruptible; commit and publication finish without interruption.
 * Failed writes roll back and never reach the publication callback.
 *
 * @param write - Store operations sharing this transaction.
 * @param publish - Live changes derived from the committed result.
 * @returns The committed result after publication.
 *
 * @example
 * ```ts
 * const saved = yield* commit(
 *   tx => sessionStore.update(tx, id, {title}),
 *   info => events.publish(Updated, {sessionID: info.id, info}),
 * );
 * ```
 */
export function commit<A, E, R>(
  write: (tx: Tx) => Effect.Effect<A, E>,
  publish: (value: A) => Effect.Effect<unknown, never, R>,
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service;
    const events = yield* Events.Service;
    return yield* events.withBarrier(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* database.db.transaction((tx) =>
            restore(write(tx)),
          );
          yield* publish(result);
          return result;
        }),
      ),
    );
  });
}
