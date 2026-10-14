// Purpose: Reads complete canonical transcript history inside a caller-owned transaction.

import type { WithParts } from "@openchart/server/agent/contracts/message";
import { Effect } from "effect";
import { messageStore, type MessageStore } from "./store";

/**
 * Reads complete history in canonical order inside the caller's transaction.
 * @example
 * const history = yield* readHistory(tx, sessionID);
 */
export const readHistory = Effect.fn("Message.readHistory")(function* (
  tx: MessageStore.Tx,
  sessionID: string,
) {
  let cursor: string | undefined;
  const history: WithParts[] = [];
  do {
    const page = yield* messageStore.list(tx, {
      sessionID,
      limit: 100,
      cursor,
    });
    history.unshift(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return history;
});
