// Purpose: Reads and commits remembered allow patterns through the application database.

import type { Database } from "@openchart/server/db";
import * as Identifier from "@openchart/identifier";
import { Effect } from "effect";

import { permissionGrants } from "./schema";
import type { Ruleset } from "./types";

/**
 * Reads current application grants; no permission cache or historical decoder.
 * @example
 * const rules = yield* Saved.list(db);
 */
export const list = Effect.fn("PermissionSaved.list")(function* (
  db: Database.Client,
) {
  return yield* db
    .transaction((tx) => tx.select().from(permissionGrants).all())
    .pipe(
      Effect.map(
        (rows) =>
          rows.map((row) => ({
            action: row.action,
            resource: row.resource,
            decision: "allow" as const,
          })) satisfies Ruleset,
      ),
      Effect.orDie,
    );
});

/**
 * Atomically saves allow patterns, preserving existing grants on duplicates.
 * Returns after commit; callers must not hold a transaction while awaiting UI.
 * @example
 * yield* Saved.add(db, 'read', ['/notes/*']);
 */
export const add = Effect.fn("PermissionSaved.add")(function* (
  db: Database.Client,
  action: string,
  resources: readonly string[],
) {
  if (!resources.length) return;
  yield* db
    .transaction((tx) =>
      tx
        .insert(permissionGrants)
        .values(
          resources.map((resource) => ({
            id: `pgr_${Identifier.ascending()}`,
            action,
            resource,
          })),
        )
        .onConflictDoNothing({
          target: [permissionGrants.action, permissionGrants.resource],
        })
        .run(),
    )
    .pipe(Effect.orDie);
});
