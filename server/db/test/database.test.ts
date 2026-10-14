// Purpose: Verifies Database Service startup, migration, and scoped access.

import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { Database } from "@openchart/server/db";
import { migrations } from "@openchart/server/db/migration.gen";

test("initializes an empty database and exposes it through Effect", async () => {
  const inspect = Effect.gen(function* () {
    const { db } = yield* Database.Service;
    const ledger = yield* db.all<{ readonly count: number }>(sql`
      SELECT COUNT(*) AS count FROM app_schema_migrations
    `);
    const foreignKeys = yield* db.all<{ readonly foreign_keys: number }>(
      sql`PRAGMA foreign_keys`,
    );
    const busyTimeout = yield* db.all<{ readonly timeout: number }>(
      sql`PRAGMA busy_timeout`,
    );
    const agentTables = yield* db.all<{ readonly name: string }>(sql`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'agent_run'
    `);
    return { ledger, foreignKeys, busyTimeout, agentTables };
  });

  await expect(
    Effect.runPromise(
      inspect.pipe(
        Effect.provide(Database.layer(":memory:", () => Effect.void)),
      ),
    ),
  ).resolves.toEqual({
    ledger: [{ count: migrations.length }],
    foreignKeys: [{ foreign_keys: 1 }],
    busyTimeout: [{ timeout: 5000 }],
    agentTables: [{ name: "agent_run" }],
  });
});
