import type { Session as SessionInfo } from "@openchart/server/agent/contracts/session";
import { Clock, Effect } from "effect";
import { update } from "./update";

/**
 * Marks a Session archived and publishes its committed metadata. Directory
 * reads hide it; transcripts, bindings, children and execution remain available.
 * Missing Sessions fail without publication. Call outside an existing transaction.
 * @example yield* archive(sessionID);
 */
export const archive = Effect.fn("Session.archive")(function* (
  id: SessionInfo["id"],
) {
  const archivedAt = yield* Clock.currentTimeMillis;
  return yield* update(id, { archivedAt });
});
