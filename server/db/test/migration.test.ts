// Purpose: Locks checksum-ledger ordering and idempotent migration application.

import * as NodeSqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { sql } from "drizzle-orm";
import { makeWithDefaults } from "drizzle-orm/effect-sqlite-node";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { DatabaseMigration } from "@openchart/server/db/migration";

const createExample: DatabaseMigration.RegisteredMigration = {
  id: "20260903000000_create_example",
  filename: "20260903000000_create_example.ts",
  checksum: "a".repeat(64),
  up: (tx) =>
    Effect.gen(function* () {
      yield* tx.run(sql`CREATE TABLE example (id TEXT PRIMARY KEY)`);
    }),
};

test("applies only the pending migration suffix", async () => {
  const program = Effect.gen(function* () {
    const db = yield* makeWithDefaults();
    yield* DatabaseMigration.applyOnly(db, [createExample]);
    yield* DatabaseMigration.applyOnly(db, [createExample]);
    const tables = yield* db.all<{ readonly name: string }>(sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'example'
    `);
    const ledger = yield* db.all<{ readonly id: string }>(sql`
      SELECT id FROM app_schema_migrations ORDER BY version
    `);
    return { tables, ledger };
  });

  await expect(
    Effect.runPromise(
      program.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ).resolves.toEqual({
    tables: [{ name: "example" }],
    ledger: [{ id: createExample.id }],
  });
});

test("rejects checksum drift before replaying history", async () => {
  const changed = {
    ...createExample,
    checksum: "b".repeat(64),
  } satisfies DatabaseMigration.RegisteredMigration;
  const program = Effect.gen(function* () {
    const db = yield* makeWithDefaults();
    yield* DatabaseMigration.applyOnly(db, [createExample]);
    yield* DatabaseMigration.applyOnly(db, [changed]);
  });

  await expect(
    Effect.runPromise(
      program.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ).rejects.toThrow("Migration ledger drift");
});

test("rejects a non-empty database without the application ledger", async () => {
  const program = Effect.gen(function* () {
    const db = yield* makeWithDefaults();
    yield* db.run(sql`CREATE TABLE unmanaged (id TEXT PRIMARY KEY)`);
    yield* DatabaseMigration.apply(db);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

  await expect(Effect.runPromise(program)).rejects.toThrow(
    "Database is not empty and has no app_schema_migrations ledger",
  );
});
