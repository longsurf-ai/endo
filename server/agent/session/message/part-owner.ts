import type { Part } from "@openchart/server/agent/contracts/part";
import { assertExists } from "@openchart/utils/assert";
import { Effect } from "effect";
import { type MessageStore, messageStore } from "./store";

/**
 * Attaches a persisted Part's owning Message for publication within its write
 * transaction. Missing ownership is a defect; storage and decoding failures propagate.
 * @example
 * const snapshot = yield* withPartOwner(tx, part);
 */
export function withPartOwner<P extends Part>(tx: MessageStore.Tx, part: P) {
  return Effect.gen(function* () {
    const info = yield* messageStore.getInfo(tx, part.messageID);
    assertExists(info, "A persisted Part must have an owning Message");
    return { info, part };
  });
}
