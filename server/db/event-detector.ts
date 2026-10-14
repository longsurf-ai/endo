// Purpose: Captures envelope-root writes and delivers committed table changes through an injected callback.

import type { SqliteClient } from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Option, Schema, Semaphore } from "effect";

/** One changed envelope-root row, identified by its physical SQL table. */
export const Change = Schema.Struct({
  table: Schema.String,
  id: Schema.String,
  revision: Schema.Int,
});

/** A committed database change, independent of any application event protocol. */
export type Change = typeof Change.Type;

/**
 * Receives a nonempty batch once the outer transaction has committed.
 * Runs serialized and uninterruptibly; it must not open another transaction
 * on this connection. Event protocols and delivery belong to the caller.
 */
export type OnCommitted = (
  changes: ReadonlyArray<Change>,
) => Effect.Effect<void>;

const Changes = Schema.Array(Change);

/**
 * Installs connection-local root-table triggers and decorates SQL transactions.
 *
 * Call once after migrations, before exposing the connection. Root tables
 * have the four shared envelope columns; internal tables do not. The temporary
 * buffer follows transactions and savepoints; only the outer commit delivers.
 * Root writes outside a managed transaction fail instead of leaving changes
 * for an unrelated transaction. Nothing is stored in the application schema.
 *
 * @param client - The private, serialized SQLite client owned by Database.
 * @param onCommitted - The caller-owned destination for committed changes.
 * @returns An Effect that installs the detector on this client.
 *
 * @example
 * ```ts
 * yield* DatabaseMigration.apply(db);
 * yield* installEventDetector(db.$client, changes => Effect.log(changes));
 * ```
 */
export function installEventDetector(
  client: SqliteClient,
  onCommitted: OnCommitted,
) {
  return Effect.gen(function* () {
    const roots = yield* client<{ name: string }>`
      SELECT s.name FROM main.sqlite_schema AS s
      WHERE s.type = 'table' AND (
        SELECT COUNT(*) FROM pragma_table_info(s.name) AS c
        WHERE (c.name = 'id' AND c.type = 'TEXT' AND c.pk = 1)
          OR (c.name = 'revision' AND c.type = 'INTEGER' AND c."notnull" = 1)
          OR (c.name = 'created_at' AND c.type = 'INTEGER' AND c."notnull" = 1)
          OR (c.name = 'updated_at' AND c.type = 'INTEGER' AND c."notnull" = 1)
      ) = 4
      ORDER BY s.name
    `;
    yield* client`
      CREATE TEMP TABLE resource_event_transaction (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      )
    `;
    yield* client`
      CREATE TEMP TABLE resource_event_buffer (
        table_name TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (table_name, id)
      )
    `;

    for (const root of roots) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
        const row = operation === "DELETE" ? "OLD" : "NEW";
        // Identifiers are escaped by the SQL compiler. Trigger bodies cannot
        // bind parameters, so quote the schema-owned table name as SQL text.
        const table = client.literal(`'${root.name.replaceAll("'", "''")}'`);
        yield* client`
          CREATE TEMP TRIGGER ${client(`resource_event_${root.name}_${operation}`)}
          AFTER ${client.literal(operation)} ON main.${client(root.name)}
          BEGIN
            SELECT RAISE(ABORT, 'Resource writes require a Database transaction')
            WHERE NOT EXISTS (SELECT 1 FROM resource_event_transaction);
            INSERT INTO resource_event_buffer (table_name, id, revision)
            VALUES (${table}, ${client.literal(`${row}.id`)}, ${client.literal(`${row}.revision`)})
            ON CONFLICT (table_name, id) DO UPDATE SET revision = excluded.revision;
          END
        `;
      }
    }

    const transaction = client.withTransaction;
    const delivery = yield* Semaphore.make(1);
    const withTransaction: SqliteClient["withTransaction"] = (effect) =>
      Effect.flatMap(
        Effect.serviceOption(client.transactionService),
        (active) => {
          // Nested transactions remain savepoints. Their buffered writes belong
          // to the outer transaction and roll back with their own savepoint.
          if (Option.isSome(active)) return transaction(effect);
          let bodyCompleted = false;
          return delivery.withPermit(
            Effect.uninterruptibleMask((restore) =>
              transaction(
                Effect.gen(function* () {
                  yield* client`INSERT INTO resource_event_transaction VALUES (1)`;
                  const value = yield* restore(effect);
                  const changes = yield* client`
                  SELECT table_name AS "table", id, revision FROM resource_event_buffer
                  ORDER BY table_name, id
                `.pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(Changes)),
                    Effect.orDie,
                  );
                  // @agent invariant: Drain before commit, deliver only after
                  // success. Rollback must discard both data and notifications.
                  yield* client`DELETE FROM resource_event_buffer`;
                  yield* client`DELETE FROM resource_event_transaction`;
                  bodyCompleted = true;
                  return { value, changes };
                }),
              ).pipe(
                // The SQL client's failure finalizer rolls back a failed body,
                // but not a failed COMMIT (for example, a deferred FK). Keep the
                // delivery lock until that still-open transaction is undone.
                Effect.onError(() =>
                  bodyCompleted
                    ? client`ROLLBACK`.pipe(Effect.orDie)
                    : Effect.void,
                ),
                Effect.tap(({ changes }) =>
                  changes.length > 0 ? onCommitted(changes) : Effect.void,
                ),
                Effect.map(({ value }) => value),
              ),
            ),
          );
        },
      );

    // Drizzle's session holds this same private client. Installing once here
    // covers db.transaction and tx.transaction without changing Store APIs.
    Object.assign(client, { withTransaction });
  });
}
