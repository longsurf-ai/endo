// Purpose: Atomically creates a Dig In child, copied history, and its parent anchor.
import { SessionId } from "@openchart/server/agent/contracts/session";
import { SessionAnchor } from "@openchart/server/agent/contracts/session-anchor";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import {
  readBranchSource,
  copyHistory,
} from "@openchart/server/agent/session/operations/internal/branch";
import { commit } from "@openchart/server/agent/session/commit";
import { BranchUnavailable } from "@openchart/server/agent/session/errors";
import {
  type SessionStore,
  sessionStore,
} from "@openchart/server/agent/session/store";
import { Effect, Schema, Struct } from "effect";

/** Creation request; selection offsets address rendered text, not raw Markdown. */
export const DigInInput = Schema.Struct({
  sessionID: SessionId,
  messageID: Schema.String.check(Schema.isMinLength(1)),
  selection: SessionAnchor.mapFields(
    (fields) => Struct.omit(fields, ["childSessionId"]),
    // The retained refinement reads only the two retained offset fields.
    { unsafePreserveChecks: true },
  ).annotate({ parseOptions: { onExcessProperty: "error" } }),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Parsed selection and source for a new Dig In child. */
export type DigInInput = typeof DigInInput.Type;

/**
 * Copies settled history through the selected reply into an unbound Dig In child.
 * The parent anchor, child, and copied history commit together before publication.
 * Each call creates a new child. Missing, synthetic, unfinished, and recursive
 * targets create nothing.
 * No Run starts here. The first ordinary prompt receives its context marker from
 * the saved anchor; copied history remains model context and is hidden from UI.
 * @example const child = yield* digIn({ sessionID, messageID, selection });
 */
export const digIn = Effect.fn("Session.digIn")(function* (input: DigInInput) {
  const publisher = yield* Publisher.Service;
  const saved = yield* commit(
    (tx) =>
      Effect.gen(function* () {
        const { source, history } = yield* readDigInSource(tx, input);
        const session = yield* sessionStore.insert(tx, {
          id: SessionId.create(),
          title: `Dig in: ${input.selection.text}`,
          parentId: source.id,
          kind: "dig_in",
          bindingId: null,
          anchors: null,
          compactingAt: null,
          archivedAt: null,
        });
        yield* copyHistory(tx, history, session.id);
        const parent = yield* sessionStore.update(tx, source.id, {
          anchors: [
            ...(source.anchors ?? []),
            {
              ...input.selection,
              childSessionId: session.id,
            },
          ],
        });
        return { session, parent };
      }),
    ({ session, parent }) =>
      Effect.gen(function* () {
        yield* publisher.publish({ type: "session.updated", session });
        yield* publisher.publish({ type: "session.updated", session: parent });
      }),
  );
  return saved.session;
});

const readDigInSource = Effect.fn("Session.readDigInSource")(function* (
  tx: SessionStore.Tx,
  input: DigInInput,
) {
  const branch = yield* readBranchSource(tx, input.sessionID, input.messageID);
  const part = branch.target.parts.find(
    (part) => part.id === input.selection.partId,
  );
  if (!part)
    return yield* new StoreNotFound({
      entity: "part",
      id: input.selection.partId,
    });
  if (part.type !== "text" || part.synthetic || !part.text.trim())
    return yield* new BranchUnavailable();
  return branch;
});
