// Purpose: Owns SQLite startup and delivery of committed row changes to an injected callback.

export * as Database from "./database";

import * as NodeSqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
  type EffectSQLiteNodeDatabase,
  makeWithDefaults,
} from "drizzle-orm/effect-sqlite-node";
import { Context, Effect, Layer } from "effect";

import { DatabaseMigration } from "./migration";
import { installEventDetector, type OnCommitted } from "./event-detector";

export type { Change, OnCommitted } from "./event-detector";

const makeDatabase = makeWithDefaults();

/** The Effect-backed Drizzle database exposed to Resource stores. */
export type Client = EffectSQLiteNodeDatabase;

/** Capabilities supplied by the application Database service. */
export interface Interface {
  /**
   * The one serialized, Effect-backed Drizzle connection. Resource writes must
   * use its transactions; Database delivers detected changes after commit.
   */
  readonly db: Client;
}

/** The application SQLite capability consumed by Resource stores. */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Database",
) {}

const databaseLayer = (onCommitted: OnCommitted) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase;

      yield* db.run("PRAGMA journal_mode = WAL");
      yield* db.run("PRAGMA synchronous = NORMAL");
      yield* db.run("PRAGMA busy_timeout = 5000");
      yield* db.run("PRAGMA cache_size = -64000");
      yield* db.run("PRAGMA foreign_keys = ON");
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)");
      yield* DatabaseMigration.apply(db);
      yield* installEventDetector(db.$client, onCommitted);

      return Service.of({ db });
    }).pipe(Effect.orDie),
  );

/**
 * Builds the Database service for one SQLite file.
 *
 * The Layer owns the connection, applies pending
 * migrations, then installs temporary Resource detectors before exposing the
 * service. Its enclosing scope closes the connection. The caller supplies the
 * committed-change destination; Database owns no event service or protocol.
 *
 * @param filename - SQLite filename, or `:memory:` for an isolated database.
 * @param onCommitted - Required destination for committed root-row changes.
 * @returns A Layer providing one initialized {@link Service}.
 *
 * @example
 * ```ts
 * const database = Database.layer(':memory:', changes => Effect.log(changes));
 * ```
 */
export function layer(filename: string, onCommitted: OnCommitted) {
  return databaseLayer(onCommitted).pipe(
    Layer.provide(NodeSqliteClient.layer({ filename })),
  );
}
