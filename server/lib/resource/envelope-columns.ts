// Purpose: Declares the shared Resource envelope columns and their database constraints.

import {
  type BuildColumns,
  type InferModelFromColumns,
  sql,
} from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  integer,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Creates fresh column builders for a Resource's server-managed envelope.
 * Resource schemas spread these into their own table declarations; internal
 * child tables share their Resource's revision and do not use this envelope.
 * The database detector identifies these roots by their complete envelope;
 * the root SQL table name must equal the Resource name used in events.
 *
 * @returns The identifier, revision, and creation and update timestamp columns.
 *
 * @example
 * ```ts
 * const note = sqliteTable(
 *   'note',
 *   {...resourceEnvelopeColumns(), title: text('title').notNull()},
 *   table => resourceEnvelopeChecks('note', table),
 * );
 * ```
 */
export function resourceEnvelopeColumns() {
  // @agent invariant: SQLite evaluates the timestamp; never supply a JS clock value.
  const now = sql<number>`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
  return {
    /** Resource identifier assigned by the intrinsic create transition. */
    id: text("id").primaryKey().notNull(),
    /** Optimistic-concurrency version starting at 1. */
    revision: integer("revision").notNull().default(1),
    /** SQLite-generated Unix epoch milliseconds when the row was created. */
    createdAt: integer("created_at").notNull().default(now),
    /** SQLite time at insert or update; Drizzle injects the SQL on updates. */
    updatedAt: integer("updated_at")
      .notNull()
      .default(now)
      .$onUpdateFn(() => now),
  };
}

/** Storage envelope read types derived from the shared columns, before domain parsing. */
export type EnvelopeRow = InferModelFromColumns<
  BuildColumns<string, ReturnType<typeof resourceEnvelopeColumns>, "sqlite">
>;

/**
 * Constrains an envelope to a non-null identifier, a positive revision, and
 * nonnegative timestamps. The Resource schema adds its own domain constraints.
 *
 * @param name - SQL table name used to namespace the constraint names.
 * @param columns - Built envelope columns supplied by Drizzle's table callback.
 * @returns Check builders to include in the table's extra configuration.
 *
 * @example
 * ```ts
 * const note = sqliteTable(
 *   'note',
 *   {...resourceEnvelopeColumns(), title: text('title').notNull()},
 *   table => resourceEnvelopeChecks('note', table),
 * );
 * ```
 */
export function resourceEnvelopeChecks(
  name: string,
  columns: Record<
    keyof ReturnType<typeof resourceEnvelopeColumns>,
    AnySQLiteColumn
  >,
) {
  return [
    // Drizzle Kit omits NOT NULL on text primary keys; SQLite needs this check.
    check(`${name}_id_check`, sql`${columns.id} IS NOT NULL`),
    check(`${name}_revision_check`, sql`${columns.revision} >= 1`),
    check(`${name}_created_at_check`, sql`${columns.createdAt} >= 0`),
    check(`${name}_updated_at_check`, sql`${columns.updatedAt} >= 0`),
  ];
}
