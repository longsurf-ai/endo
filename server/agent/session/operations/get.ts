import { type Session as SessionInfo } from "@openchart/server/agent/contracts/session";
import { Database } from "@openchart/server/db";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Effect } from "effect";

/**
 * Reads a Session, returning undefined when its identity does not exist.
 *
 * @example
 * ```ts
 * const session = yield* get(SessionId.make('ses_example'));
 * ```
 */
export const get = Effect.fn("Session.get")(function* (id: SessionInfo["id"]) {
  const { db } = yield* Database.Service;
  return yield* db.transaction((tx) => sessionStore.get(tx, id));
});
