// Purpose: Owns Resource invalidation definitions and publication from committed database changes.

import type { Database } from "@openchart/server/db";
import { EventDefinition, type Events } from "@openchart/server/events";
import { Effect, Schema } from "effect";

/**
 * Published by {@link makeOnCommitted} after the outer transaction commits,
 * once per affected Resource identity, including foreign-key cascades.
 *
 * It carries identity and revision only. Subscribers refetch canonical state
 * through tRPC `get`/`list`; nothing reconstructs an entity from this event.
 * Deletion retains the deleted row's revision. Equal revisions must not
 * suppress invalidation: the entity may no longer exist.
 *
 * @example
 * ```ts
 * yield* events.publish(ResourceChanged, {resource: 'agent_schedule', id, revision});
 * ```
 */
export const ResourceChanged = EventDefinition.define({
  type: "resource.changed",
  schema: {
    resource: Schema.String,
    id: Schema.String,
    revision: Schema.Int,
  },
});

/**
 * Creates the database callback that publishes Resource invalidations.
 *
 * Resource root table names are their Resource names. Database invokes this
 * callback only after commit; application composition supplies the shared
 * Events instance and injects the callback without interpreting changed rows.
 *
 * @param events - The application's shared event publisher.
 * @returns A callback satisfying Database's committed-change contract.
 *
 * @example
 * ```ts
 * const events = yield* Events.Service;
 * const database = Database.layer(':memory:', makeOnCommitted(events));
 * ```
 */
export function makeOnCommitted(
  events: Events.Interface,
): Database.OnCommitted {
  return (changes) =>
    Effect.forEach(
      changes,
      (change, index) =>
        events
          .publish(ResourceChanged, {
            resource: change.table,
            id: change.id,
            revision: change.revision,
          })
          .pipe(
            // Let SSE consumers drain during bulk commits; keep every identity event.
            Effect.andThen(index % 64 === 63 ? Effect.yieldNow : Effect.void),
          ),
      { discard: true },
    );
}
