import {
  type Session as SessionInfo,
  SessionId,
} from "@openchart/server/agent/contracts/session";
import { commit } from "@openchart/server/agent/session/commit";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Effect } from "effect";

/** Creation inputs; omitted parent and kind create an ordinary root Session. */
export type CreateInput = Readonly<
  Partial<Pick<SessionInfo, "id" | "title" | "parentId" | "kind">>
>;

/**
 * Creates an unbound Session and publishes its committed snapshot.
 *
 * A supplied ID must be new. Otherwise this operation generates a Session ID.
 * The default title is "New session". Parent defaults to null and kind to chat;
 * callers supply them when creating a delegate. Binding, anchors, and lifecycle
 * timestamps start as null; transcript branching remains a separate operation.
 * Call at the execution boundary, outside any existing database transaction.
 *
 * @example
 * ```ts
 * const session = yield* create({title: 'Market analysis'});
 * ```
 */
export const create = Effect.fn("Session.create")(function* (
  input: CreateInput = {},
) {
  const publisher = yield* Publisher.Service;
  return yield* commit(
    (tx) =>
      sessionStore.insert(tx, {
        id: input.id ?? SessionId.create(),
        title: input.title ?? "New session",
        parentId: input.parentId ?? null,
        kind: input.kind ?? "chat",
        bindingId: null,
        anchors: null,
        compactingAt: null,
        archivedAt: null,
      }),
    (session) => publisher.publish({ type: "session.updated", session }),
  );
});
