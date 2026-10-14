// Purpose: Attaches an existing Session to an opaque feature slot.
import { defineId } from "@openchart/identifier";
import { SessionId } from "@openchart/server/agent/contracts/session";
import { commit } from "@openchart/server/agent/session/commit";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Effect } from "effect";

const BindingId = defineId("asb", "AgentSessionBinding.ID");
/**
 * Binds an existing Session without creating or executing one. Repeating the same
 * attachment is harmless; moving a Session to another slot fails. Current remains
 * the newest Session by creation order, so late attachment never promotes history.
 * Commits and publishes through the usual Session boundary; call outside a transaction.
 * @example yield* sessions.bindExisting({sessionId: child.id, key: "feature:cell"});
 */
export const bindExisting = Effect.fn("Session.bindExisting")(
  function* (input: { sessionId: SessionId; key: string }) {
    const publisher = yield* Publisher.Service;
    return yield* commit(
      (tx) =>
        Effect.gen(function* () {
          const session = yield* sessionStore.get(tx, input.sessionId);
          if (!session)
            return yield* Effect.fail(
              new Error("Cannot bind a missing Session."),
            );
          const bindingId = yield* sessionStore.ensureBinding(tx, {
            id: BindingId.create(),
            key: input.key,
          });
          if (session.bindingId && session.bindingId !== bindingId)
            return yield* Effect.fail(
              new Error("Session already belongs to another binding."),
            );
          return yield* sessionStore.update(tx, input.sessionId, { bindingId });
        }),
      (session) => publisher.publish({ type: "session.updated", session }),
    );
  },
);
