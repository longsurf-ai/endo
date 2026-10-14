// Purpose: Reads a visible page of complete turns through the existing transcript store.
import { StoreNotFound } from "@openchart/server/agent/errors";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Database } from "@openchart/server/db";
import { Effect, Schema } from "effect";

/** All observers bootstrap the same latest-turn window on the shared bus. */
export const DEFAULT_HISTORY_TURN_LIMIT = 5;

/** Cursor and turn count for a read-only history page; no cursor selects the tail. */
export const TranscriptPageInput = Schema.Struct({
  sessionID: Schema.String.check(Schema.isMinLength(1)),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  turnLimit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
});

/**
 * Reads Session metadata and a complete-turn page in one transaction. History
 * is already visibility-filtered, including Dig In pages after their marker.
 * Missing Sessions and invalid/cross-session cursors fail; no execution occurs.
 * @example const page = yield* readTranscriptPage({sessionID, turnLimit: 5});
 */
export const readTranscriptPage = Effect.fn("Session.readTranscriptPage")(
  function* (input: typeof TranscriptPageInput.Type) {
    const { db } = yield* Database.Service;
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const session = yield* sessionStore.get(tx, input.sessionID);
        if (!session)
          return yield* new StoreNotFound({
            entity: "session",
            id: input.sessionID,
          });
        const page = yield* messageStore.listTurns(tx, {
          sessionID: input.sessionID,
          turnLimit: input.turnLimit ?? DEFAULT_HISTORY_TURN_LIMIT,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        return { session, history: page.items, nextCursor: page.nextCursor };
      }),
    );
  },
);
