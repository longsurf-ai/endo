import { type Part } from "@openchart/server/agent/contracts/part";
import { commit } from "@openchart/server/agent/session/commit";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { withPartOwner } from "@openchart/server/agent/session/message/part-owner";
import { Effect } from "effect";

/**
 * Inserts a batch of Parts in order and publishes only after the entire commit.
 *
 * Every Part keeps its caller-supplied identity and owning Message. Duplicate IDs
 * or invalid Parts roll back the whole batch and publish nothing. Empty batches
 * are no-ops. Call outside any existing transaction.
 * @example
 * const saved = yield* createParts(parts);
 */
export const createParts = Effect.fn("Message.createParts")(function* <
  P extends Part,
>(parts: readonly P[]) {
  if (parts.length === 0) return [];
  const publisher = yield* Publisher.Service;
  const saved = yield* commit(
    (tx) =>
      Effect.forEach(parts, (part) =>
        messageStore
          .insertPart(tx, part)
          .pipe(Effect.flatMap((part) => withPartOwner(tx, part))),
      ),
    (saved) =>
      Effect.forEach(
        saved,
        (snapshot) => publisher.publish({ type: "part.updated", ...snapshot }),
        { discard: true },
      ),
  );
  return saved.map((snapshot) => snapshot.part);
});
