// Purpose: Defines missing targets and immutable-field conflicts for Agent persistence.

import { Schema } from "effect";

/**
 * An update requires an existing row; reads represent absence with undefined.
 *
 * @example
 * ```ts
 * const error = new StoreNotFound({entity: 'session', id: 'session-1'});
 * ```
 */
export class StoreNotFound extends Schema.TaggedError<StoreNotFound>()(
  "AgentStore.NotFound",
  {
    entity: Schema.Literals(["session", "message", "part"]),
    id: Schema.String,
  },
) {
  /** Names the missing row for callers that consume the standard Error interface. */
  override get message() {
    return `${this.entity} ${this.id} was not found`;
  }
}

/**
 * A write would change a row's immutable owner or discriminant.
 *
 * @example
 * ```ts
 * const error = new StoreWriteConflict({
 *   entity: 'part', id: 'part-1', field: 'messageID',
 *   expected: 'message-1', actual: 'message-2',
 * });
 * ```
 */
export class StoreWriteConflict extends Schema.TaggedError<StoreWriteConflict>()(
  "AgentStore.WriteConflict",
  {
    entity: Schema.Literals(["message", "part"]),
    id: Schema.String,
    field: Schema.Literals(["sessionID", "messageID", "role", "type"]),
    expected: Schema.String,
    actual: Schema.String,
  },
) {}
