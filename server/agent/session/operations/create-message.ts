import { type WithParts } from "@openchart/server/agent/contracts/message";
import { commit } from "@openchart/server/agent/session/commit";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Effect } from "effect";

/**
 * Atomically creates a Message and its initial Parts and touches its Session.
 *
 * After commit, publishes the saved aggregate and updated Session.
 * Failure rolls back the entire aggregate and publishes nothing.
 * Call outside any existing transaction; this operation does not enqueue a Run.
 *
 * @example
 * ```ts
 * const message = yield* createMessage({info, parts});
 * ```
 */
export const createMessage = Effect.fn("Message.create")(function* (
  input: WithParts,
) {
  const publisher = yield* Publisher.Service;
  const saved = yield* commit(
    (tx) =>
      Effect.gen(function* () {
        const message = yield* messageStore.insert(tx, input);
        const session = yield* sessionStore.update(
          tx,
          input.info.sessionID,
          {},
        );
        return { message, session };
      }),
    ({ message, session }) =>
      Effect.gen(function* () {
        yield* publisher.publish({ type: "message.created", message });
        yield* publisher.publish({ type: "session.updated", session });
      }),
  );
  return saved.message;
});
