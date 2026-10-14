import {
  SessionId,
  type SessionKind,
} from "@openchart/server/agent/contracts/session";
import { defineId } from "@openchart/identifier";
import { commit } from "@openchart/server/agent/session/commit";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Effect, Struct } from "effect";

const BindingId = defineId("asb", "AgentSessionBinding.ID");

/**
 * Returns the newest Session in a feature's slot, creating it only when empty.
 * Keys are opaque and globally unique. Binding and initial Session creation
 * share the existing Session transaction; only a newly created Session publishes.
 * The caller supplies the initial Session kind; an existing Session stays unchanged.
 * Call outside an existing transaction. This operation never submits a prompt.
 * @example
 * const session = yield* getOrCreateBound({key: 'research:topic', kind: 'chat', title: 'Research'});
 */
export const getOrCreateBound = Effect.fn("Session.getOrCreateBound")(
  function* (input: {
    readonly key: string;
    readonly kind: SessionKind;
    readonly title?: string;
  }) {
    const publisher = yield* Publisher.Service;
    const result = yield* commit(
      (tx) =>
        Effect.gen(function* () {
          const bindingId = yield* sessionStore.ensureBinding(tx, {
            id: BindingId.create(),
            key: input.key,
          });
          const { items } = yield* sessionStore.list(tx, {
            bindingId,
            limit: 1,
          });
          const current = items[0];
          if (current)
            return {
              session: Struct.omit(current, ["isActive", "isUnread"]),
              created: false,
            };
          const session = yield* sessionStore.insert(tx, {
            id: SessionId.create(),
            title: input.title ?? "New session",
            bindingId,
            parentId: null,
            kind: input.kind,
            anchors: null,
            compactingAt: null,
            archivedAt: null,
          });
          return { session, created: true };
        }),
      (result) =>
        result.created
          ? publisher.publish({
              type: "session.updated",
              session: result.session,
            })
          : Effect.void,
    );
    return result.session;
  },
);
