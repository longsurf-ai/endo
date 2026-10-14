import { type MessageInfo } from "@openchart/server/agent/contracts/message";
import { commit } from "@openchart/server/agent/session/commit";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { assertExists } from "@openchart/utils/assert";
import { Effect } from "effect";

/**
 * Updates an existing Message header and publishes its committed snapshot.
 *
 * Preserves identity, Session, and role. Use finishStep when this change must
 * commit together with a StepFinishPart. Call outside an existing transaction.
 *
 * @example
 * ```ts
 * const saved = yield* updateMessage(info);
 * ```
 */
export const updateMessage = Effect.fn("Message.update")(function* <
  I extends MessageInfo,
>(info: I) {
  const publisher = yield* Publisher.Service;
  const saved = yield* commit(
    (tx) =>
      Effect.gen(function* () {
        const previous = yield* messageStore.getInfo(tx, info.id);
        const message = yield* messageStore.update(tx, info);
        assertExists(
          previous,
          "An updated Message must have a previous header",
        );
        return { message, previous };
      }),
    (saved) => publisher.publish({ type: "message.updated", ...saved }),
  );
  return saved.message;
});
