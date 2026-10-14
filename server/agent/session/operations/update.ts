import { type Session as SessionInfo } from "@openchart/server/agent/contracts/session";
import { commit } from "@openchart/server/agent/session/commit";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Effect, Struct } from "effect";

/** Metadata changes; omitted values stay unchanged and explicit null clears. */
export type UpdateInput = Readonly<
  Partial<Pick<SessionInfo, "title" | "compactingAt" | "archivedAt">>
>;

/**
 * Updates existing Session metadata and publishes the committed snapshot.
 *
 * Identity, relationships, anchors, and SQL row timestamps are not writable
 * through this operation. Missing Sessions fail without publishing an event.
 * Call outside any existing database transaction.
 *
 * @example
 * ```ts
 * const session = yield* update(id, {title: 'Summary', archivedAt: null});
 * ```
 */
export const update = Effect.fn("Session.update")(function* (
  id: SessionInfo["id"],
  changes: UpdateInput,
) {
  const publisher = yield* Publisher.Service;
  return yield* commit(
    (tx) =>
      sessionStore.update(
        tx,
        id,
        Struct.pick(changes, ["title", "compactingAt", "archivedAt"]),
      ),
    (session) => publisher.publish({ type: "session.updated", session }),
  );
});
