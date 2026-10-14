// Purpose: Defines transaction-bound Resource stores with typed writes and unparsed reads.

import type { Database } from "@openchart/server/db";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import type { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type { EnvelopeRow } from "./envelope-columns";
import type { WritableSchema } from "./write-schema";
import type { ListWindow } from "./pagination";
import type { ResourceStateInvalid } from "./errors";

/**
 * Internal writes accept either the complete domain body or its client-writable
 * projection. Stores preserve existing managed data when it is omitted and
 * persist explicitly supplied managed data according to their storage invariants.
 * The entity schema remains the source of both shapes; neither includes the envelope.
 */
export type StoreBody<Entity extends Schema.Constraint> =
  Omit<Entity["Type"], keyof EnvelopeRow> | WritableSchema<Entity>["Type"];

/** The Drizzle transaction handle opened by the Transactor. */
export type Tx = Parameters<Parameters<Database.Client["transaction"]>[0]>[0];

/** Database failures and caller-correctable errors when deriving managed data. */
export type StoreError =
  SqlError | EffectDrizzleQueryError | ResourceStateInvalid;

/**
 * One persisted entity as the Store hands it to Resource transitions.
 *
 * The envelope fields are columns everywhere; `body` is the domain object
 * still unparsed, because shared Resource operation decoders own the schema boundary.
 * A store assembling its body from several tables returns the same shape.
 */
export type Row<EntityBody = unknown> = Readonly<
  EnvelopeRow & { body: EntityBody }
>;

/** Insert fields supplied by a transition; SQLite supplies both timestamps. */
export type InsertInput<EntityBody = unknown> = Pick<
  Row<EntityBody>,
  "id" | "revision" | "body"
>;

/** Domain body and revision to save; SQLite supplies the update timestamp. */
export type SaveInput<EntityBody = unknown> = Pick<
  Row<EntityBody>,
  "revision" | "body"
>;

/**
 * Persistence for one Resource with typed internal writes and complete read rows.
 *
 * Each Resource maps its own tables to this interface. Writes receive domain
 * bodies supplied by transitions, including server-managed data. Client write
 * restrictions belong to the client schemas and intrinsic transitions. Stores
 * preserve or generate omitted managed data and enforce storage invariants for
 * supplied values. Reads return unknown full domain bodies for Resource
 * transitions to decode. Every method requires the enclosing transaction.
 */
export interface Store<
  EntityBody = unknown,
  Filter = Readonly<Record<string, unknown>>,
> {
  /**
   * Reads one row by identifier.
   *
   * @param tx - The enclosing transaction.
   * @param id - Resource identifier.
   * @returns The row, or `undefined` when absent.
   *
   * @example
   * ```ts
   * const row = yield* store.load(tx, id);
   * ```
   */
  readonly load: (
    tx: Tx,
    id: string,
  ) => Effect.Effect<Row | undefined, StoreError>;
  /**
   * Reads a bounded window in creation order. Provided filters use scalar equality
   * joined by AND; omitted keys impose no condition. The store owns execution.
   *
   * @param tx - The enclosing transaction.
   * @param filter - Parsed equality filters; no conditions means every row.
   * @param window - Exclusive cursor and maximum row count, including lookahead.
   * @returns At most window.limit matching rows, ordered by creation time and id.
   *
   * @example
   * ```ts
   * const rows = yield* store.list(tx, {}, {limit: 51});
   * ```
   */
  readonly list: (
    tx: Tx,
    filter: Filter,
    window: ListWindow,
  ) => Effect.Effect<ReadonlyArray<Row>, StoreError>;
  /**
   * Inserts a new row using the database timestamp defaults.
   *
   * @param tx - The enclosing transaction.
   * @param input - Identifier, initial revision, and parsed domain body.
   * @returns The inserted row, including its database-generated timestamps.
   *
   * @example
   * ```ts
   * const row = yield* store.insert(tx, {id, revision: 1, body});
   * ```
   */
  readonly insert: (
    tx: Tx,
    input: InsertInput<EntityBody>,
  ) => Effect.Effect<Row, StoreError>;
  /**
   * Saves the supplied domain fields and revision, including managed values
   * supplied by internal transitions. Omitted managed data is preserved.
   *
   * @param tx - The enclosing transaction.
   * @param id - Resource identifier of a row the caller has already loaded.
   * @param input - New body and revision.
   * @returns The row as stored, including its database-generated update time.
   *
   * @example
   * ```ts
   * const row = yield* store.save(tx, id, {body, revision: 2});
   * ```
   */
  readonly save: (
    tx: Tx,
    id: string,
    input: SaveInput<EntityBody>,
  ) => Effect.Effect<Row, StoreError>;
  /**
   * Deletes one row. Owned rows in other tables follow through FK cascade.
   *
   * @param tx - The enclosing transaction.
   * @param id - Resource identifier of a row the caller has already loaded.
   *
   * @example
   * ```ts
   * yield* store.remove(tx, id);
   * ```
   */
  readonly remove: (tx: Tx, id: string) => Effect.Effect<void, StoreError>;
}
