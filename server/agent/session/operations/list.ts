import { Database } from "@openchart/server/db";
import {
  type SessionStore,
  sessionStore,
} from "@openchart/server/agent/session/store";
import { Effect } from "effect";

/**
 * Reads a bounded newest-first page, preserving the Store's order, filters and cursor.
 * Without a cursor, reads the newest page; nextCursor moves toward older
 * Sessions. Creation time is the default; the directory selects updatedAt.
 *
 * ```text
 * Sessions (oldest -> newest): [a, b, c, d]
 * With limit: 2
 *   First call (no cursor):    [d, c]
 *   Next call (nextCursor):    [b, a]
 * ```
 *
 * @example
 * ```ts
 * const page = yield* list({parentId: null, limit: 20});
 * ```
 */
export const list = Effect.fn("Session.list")(function* (
  input: SessionStore.ListInput,
) {
  const { db } = yield* Database.Service;
  return yield* db.transaction((tx) => sessionStore.list(tx, input));
});
