import { Database } from "@openchart/server/db";
import {
  type MessageStore,
  messageStore,
} from "@openchart/server/agent/session/message/store";
import { Effect } from "effect";

/**
 * Reads a Part under its Message and Session, or undefined when absent.
 *
 * @example
 * ```ts
 * const part = yield* getPart({sessionID, messageID, partID});
 * ```
 */
export const getPart = Effect.fn("Message.getPart")(function* (
  key: MessageStore.PartKey,
) {
  const { db } = yield* Database.Service;
  return yield* db.transaction((tx) => messageStore.getPart(tx, key));
});
