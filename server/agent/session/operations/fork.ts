// Purpose: Creates an independent conversation from a committed Assistant reply.
import { SessionId } from "@openchart/server/agent/contracts/session";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Effect } from "effect";
import {
  readBranchSource,
  copyHistory,
} from "@openchart/server/agent/session/operations/internal/branch";
import { commit } from "@openchart/server/agent/session/commit";
import {
  type SessionStore,
  sessionStore,
} from "@openchart/server/agent/session/store";

/**
 * Copies history through a completed Assistant (inclusive) into an unbound root
 * Session. Fresh Message/Part IDs preserve ordering and internal references;
 * provider IDs, evidence, and historical delegate links retain their meaning.
 * No Runs, bindings, approvals, or execution are copied. Source history is untouched.
 * Reads and writes share one transaction; only the complete Session is published.
 * Missing targets, unfinished history, and Dig In sources create no Session.
 * @example
 * const branch = yield* fork({ sessionID, messageID });
 */
export const fork = Effect.fn("Session.fork")(function* (input: {
  readonly sessionID: SessionId;
  readonly messageID: string;
}) {
  const publisher = yield* Publisher.Service;
  return yield* commit(
    (tx) =>
      Effect.gen(function* () {
        const { source, history } = yield* readBranchSource(
          tx,
          input.sessionID,
          input.messageID,
        );
        const session = yield* createForkSession(tx, source.title);
        yield* copyHistory(tx, history, session.id);
        return session;
      }),
    (session) => publisher.publish({ type: "session.updated", session }),
  );
});

const createForkSession = Effect.fn("Session.createForkSession")(function* (
  tx: SessionStore.Tx,
  sourceTitle: string,
) {
  return yield* sessionStore.insert(tx, {
    id: SessionId.create(),
    title: `Branch of ${sourceTitle}`,
    parentId: null,
    kind: "chat",
    bindingId: null,
    anchors: null,
    compactingAt: null,
    archivedAt: null,
  });
});
