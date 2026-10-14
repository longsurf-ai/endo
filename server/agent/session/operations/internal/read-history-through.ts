// Purpose: Shares inclusive history selection for branching and truncation.
import type { SessionId } from "@openchart/server/agent/contracts/session";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { readHistory } from "@openchart/server/agent/session/message/history";
import {
  sessionStore,
  type SessionStore,
} from "@openchart/server/agent/session/store";
import { Effect } from "effect";

/**
 * Reads an existing Session and its storage-ordered history through a Message,
 * including that Message. Null selects empty history. Missing Sessions and
 * missing/foreign boundaries fail; callers own eligibility checks and writes.
 * Uses the caller's transaction without publishing or starting execution.
 * @example const { source, history } = yield* readHistoryThrough(tx, sessionID, messageID);
 */
export const readHistoryThrough = Effect.fn("Session.readHistoryThrough")(
  function* (
    tx: SessionStore.Tx,
    sessionID: SessionId,
    messageID: string | null,
  ) {
    const source = yield* sessionStore.get(tx, sessionID);
    if (!source)
      return yield* new StoreNotFound({ entity: "session", id: sessionID });
    if (messageID === null) return { source, history: [] };

    const history = yield* readHistory(tx, sessionID);
    const boundary = history.findIndex(({ info }) => info.id === messageID);
    if (boundary < 0)
      return yield* new StoreNotFound({ entity: "message", id: messageID });
    return { source, history: history.slice(0, boundary + 1) };
  },
);
