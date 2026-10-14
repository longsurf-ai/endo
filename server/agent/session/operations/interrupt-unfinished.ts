import { Database } from "@openchart/server/db";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { Clock, Effect } from "effect";

/**
 * Closes abandoned Assistants and active Parts across all Sessions at startup.
 * Owns the repair transaction and reads its timestamp from Clock. Call before
 * execution or observers exist; no live events are published. Failure rolls back
 * this repair, and repeating it preserves completed content and existing errors.
 * @example
 * yield* interruptUnfinished();
 */
export const interruptUnfinished = Effect.fn("Message.interruptUnfinished")(
  function* () {
    const { db } = yield* Database.Service;
    const time = yield* Clock.currentTimeMillis;
    yield* db.transaction((tx) => messageStore.interruptUnfinished(tx, time));
  },
);
