// Purpose: Applies and verifies the one ordered application migration stream.

export * as DatabaseMigration from "./migration";

import { sql } from "drizzle-orm";
import type { EffectSQLiteNodeDatabase } from "drizzle-orm/effect-sqlite-node";
import { Effect, Semaphore } from "effect";

import { migrations } from "./migration.gen";
import schema from "./schema.gen";

type Transaction = Parameters<
  Parameters<EffectSQLiteNodeDatabase["transaction"]>[0]
>[0];

interface LedgerRow {
  readonly version: number;
  readonly id: string;
  readonly filename: string;
  readonly checksum: string;
  readonly applied_at: string;
}

/** One forward migration authored under `db/migration/`. */
export interface Migration {
  /** Timestamp-prefixed stable migration identifier. */
  readonly id: string;
  /** Applies the migration inside the runner-owned transaction. */
  readonly up: (tx: Transaction) => Effect.Effect<void, unknown>;
}

/** Generated immutable metadata paired with one migration implementation. */
export interface RegisteredMigration extends Migration {
  /** Source filename recorded in the database ledger. */
  readonly filename: string;
  /** SHA-256 of the migration source when the registry was generated. */
  readonly checksum: string;
}

const ledger = "app_schema_migrations";
const lock = Semaphore.makeUnsafe(1);
const idPattern = /^(\d{14})_[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const checksumPattern = /^[a-f0-9]{64}$/;

/**
 * Initializes or upgrades an application database to the current schema.
 *
 * Empty databases take the generated full-schema fast path and record every
 * historical migration without replaying it. Existing databases must own a
 * ledger matching the generated registry exactly; only its pending suffix is
 * applied.
 *
 * @param db - Effect-backed Drizzle database to initialize.
 * @returns An Effect that completes only after full ledger verification.
 * @throws If the database is unmanaged or its migration history drifted.
 *
 * @example
 * ```ts
 * yield* DatabaseMigration.apply(db);
 * ```
 */
export function apply(db: EffectSQLiteNodeDatabase) {
  return lock.withPermit(
    Effect.gen(function* () {
      validateRegistry(migrations);
      const tables = yield* db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      const hasLedger = tables.some((table) => table.name === ledger);
      if (hasLedger) {
        yield* applyOnly(db, migrations);
        return;
      }
      if (tables.length > 0) {
        return yield* Effect.die(
          `Database is not empty and has no ${ledger} ledger`,
        );
      }

      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx);
          yield* createLedger(tx);
          yield* Effect.forEach(migrations, (migration) =>
            record(tx, migration),
          );
        }),
      );
      yield* verifyLedger(db, migrations, true);
    }),
  );
}

/**
 * Applies a supplied migration registry to an existing database.
 *
 * This lower-level entry is intended for migration upgrade tests. Production
 * startup uses {@link apply}, which also handles the generated full-schema
 * fast path.
 *
 * @param db - Database whose ledger and schema will be upgraded.
 * @param input - Complete ordered registry, including already-applied entries.
 * @returns An Effect that applies only the pending suffix.
 * @throws If existing ledger rows are not an exact prefix of `input`.
 *
 * @example
 * ```ts
 * yield* DatabaseMigration.applyOnly(db, testMigrations);
 * ```
 */
export function applyOnly(
  db: EffectSQLiteNodeDatabase,
  input: readonly RegisteredMigration[],
) {
  return Effect.gen(function* () {
    validateRegistry(input);
    yield* db.run(createLedgerSql);
    const completed = yield* verifyLedger(db, input, false);

    for (const migration of input.slice(completed)) {
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx);
          yield* record(tx, migration);
        }),
      );
    }

    yield* verifyLedger(db, input, true);
  });
}

const createLedgerSql = sql`
  CREATE TABLE IF NOT EXISTS ${sql.identifier(ledger)} (
    version INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

function createLedger(tx: Transaction) {
  return tx.run(createLedgerSql);
}

function record(tx: Transaction, migration: RegisteredMigration) {
  const version = versionOf(migration);
  return tx.run(sql`
    INSERT INTO ${sql.identifier(ledger)}
      (version, id, filename, checksum, applied_at)
    VALUES (
      ${version},
      ${migration.id},
      ${migration.filename},
      ${migration.checksum},
      ${new Date().toISOString()}
    )
  `);
}

function verifyLedger(
  db: EffectSQLiteNodeDatabase,
  expected: readonly RegisteredMigration[],
  complete: boolean,
) {
  return Effect.gen(function* () {
    const rows = yield* db.all<LedgerRow>(sql`
      SELECT version, id, filename, checksum, applied_at
      FROM ${sql.identifier(ledger)}
      ORDER BY version
    `);
    if (rows.length > expected.length) {
      return yield* Effect.die(
        "Migration ledger contains entries missing from this repository",
      );
    }
    for (const [index, row] of rows.entries()) {
      const migration = expected[index];
      if (!migration) {
        return yield* Effect.die(`Unexpected migration ledger row ${row.id}`);
      }
      if (
        row.version !== versionOf(migration) ||
        row.id !== migration.id ||
        row.filename !== migration.filename ||
        row.checksum !== migration.checksum ||
        !Number.isFinite(Date.parse(row.applied_at))
      ) {
        return yield* Effect.die(
          `Migration ledger drift at ${migration.filename}`,
        );
      }
    }
    if (complete && rows.length !== expected.length) {
      return yield* Effect.die("Migration ledger is missing applied entries");
    }
    return rows.length;
  });
}

function validateRegistry(input: readonly RegisteredMigration[]): void {
  const ids = new Set<string>();
  const filenames = new Set<string>();
  let previous = "";
  for (const migration of input) {
    const match = idPattern.exec(migration.id);
    if (!match) throw new Error(`Invalid migration id: ${migration.id}`);
    if (migration.filename !== `${migration.id}.ts`) {
      throw new Error(`Migration filename does not match id: ${migration.id}`);
    }
    if (!checksumPattern.test(migration.checksum)) {
      throw new Error(`Invalid migration checksum: ${migration.filename}`);
    }
    if (ids.has(migration.id) || filenames.has(migration.filename)) {
      throw new Error(`Duplicate migration: ${migration.filename}`);
    }
    if (previous && migration.id <= previous) {
      throw new Error(`Migrations are out of order: ${migration.filename}`);
    }
    ids.add(migration.id);
    filenames.add(migration.filename);
    previous = migration.id;
  }
}

function versionOf(migration: RegisteredMigration): number {
  const match = idPattern.exec(migration.id);
  if (!match?.[1]) throw new Error(`Invalid migration id: ${migration.id}`);
  return Number(match[1]);
}
