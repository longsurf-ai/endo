import { type Part } from "@openchart/server/agent/contracts/part";
import { commit } from "@openchart/server/agent/session/commit";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { withPartOwner } from "@openchart/server/agent/session/message/part-owner";
import { Effect } from "effect";

/**
 * Updates a Part and publishes its committed snapshot under its Message's Session.
 *
 * Ownership and Part type remain immutable. Call outside an existing transaction.
 *
 * @example
 * ```ts
 * const saved = yield* updatePart(part);
 * ```
 */
export const updatePart = Effect.fn("Message.updatePart")(function* <
  P extends Part,
>(part: P) {
  const publisher = yield* Publisher.Service;
  const saved = yield* commit(
    (tx) =>
      Effect.gen(function* () {
        const owner = yield* withPartOwner(tx, part);
        const previous = yield* messageStore.getPart(tx, {
          sessionID: owner.info.sessionID,
          messageID: part.messageID,
          partID: part.id,
        });
        const saved = yield* messageStore.updatePart(tx, part);
        return { ...owner, part: saved, previous };
      }),
    (saved) => publisher.publish({ type: "part.updated", ...saved }),
  );
  return saved.part;
});
