import { Database } from "@openchart/server/db";
import {
  type MessageStore,
  messageStore,
} from "@openchart/server/agent/session/message/store";
import { Effect } from "effect";

/**
 * Reads a scoped Message with all of its Parts, or undefined when absent.
 *
 * @example
 * ```ts
 * const message = yield* getMessage({sessionID, messageID});
 * ```
 */
export const getMessage = Effect.fn("Message.get")(function* (
  key: MessageStore.MessageKey,
) {
  const { db } = yield* Database.Service;
  return yield* db.transaction((tx) => messageStore.get(tx, key));
});
