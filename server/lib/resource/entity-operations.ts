// Purpose: Shares Resource existence, revision, and stored-entity decoding rules across transitions.

import { Effect, Schema } from "effect";

import { STRICT_PARSE_OPTIONS } from "./definition";
import type { PureCodec } from "./definition";
import { ResourceNotFound, RevisionConflict } from "./errors";
import type { Row, Store, Tx } from "./store";

/**
 * Loads the addressed row in the caller's transaction or fails with NotFound.
 *
 * @example
 * ```ts
 * const row = yield* loadExisting(store, 'agent_schedule', tx, id);
 * ```
 */
export const loadExisting = Effect.fn("Resource.loadExisting")(function* (
  store: Pick<Store, "load">,
  resource: string,
  tx: Tx,
  id: string,
) {
  const row = yield* store.load(tx, id);
  if (!row) return yield* new ResourceNotFound({ resource, id });
  return row;
});

/**
 * Rejects a stale expected revision before a transition performs any writes.
 *
 * @example
 * ```ts
 * yield* checkRevision('agent_schedule', row, input.expectedRevision);
 * ```
 */
export const checkRevision = Effect.fn("Resource.checkRevision")(function* (
  resource: string,
  row: Pick<Row, "id" | "revision">,
  expected: number,
) {
  if (row.revision !== expected) {
    return yield* new RevisionConflict({
      resource,
      id: row.id,
      expected,
      actual: row.revision,
    });
  }
});

/**
 * Decodes the complete stored entity before commit; invalid stored state is a defect.
 *
 * @example
 * ```ts
 * return yield* toEntity('agent_schedule', AgentScheduleEntity, row);
 * ```
 */
export function toEntity<S extends Schema.Schema<unknown> & PureCodec>(
  resource: string,
  schema: S,
  row: Row,
): Effect.Effect<S["Type"]> {
  return Schema.decodeUnknownEffect(
    schema,
    STRICT_PARSE_OPTIONS,
  )({
    ...(row.body as Record<string, unknown>),
    id: row.id,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(
    Effect.mapError(
      (error) =>
        new Error(
          `Resource ${resource} ${row.id} failed its entity schema: ${error.message}`,
        ),
    ),
    Effect.orDie,
  );
}
