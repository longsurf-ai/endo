import { Database } from "@openchart/server/db";
import {
  type MessageStore,
  messageStore,
} from "@openchart/server/agent/session/message/store";
import { Effect } from "effect";

/**
 * Reads one complete-message page and its continuation toward older history.
 * Without a cursor, reads the newest page; nextCursor moves toward older
 * history. Each page returns its Messages oldest-first.
 *
 * ```text
 * History (oldest -> newest): [a, b, c, d]
 * With limit: 2
 *   First call (no cursor):   [c, d]
 *   Next call (nextCursor):   [a, b]
 * ```
 *
 * @example
 * ```ts
 * const page = yield* listMessages({sessionID, limit: 20});
 * ```
 */
export const listMessages = Effect.fn("Message.list")(function* (
  input: MessageStore.ListInput,
) {
  const { db } = yield* Database.Service;
  return yield* db.transaction((tx) => messageStore.list(tx, input));
});
