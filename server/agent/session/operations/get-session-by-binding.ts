import { Database } from "@openchart/server/db";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Effect, Struct } from "effect";

/** Read a slot's newest Session without creating a binding or Session.
 * Returns null for an empty slot; database failures propagate.
 * @example const session = yield* getSessionByBinding({ key: "drawing:drw_example" });
 */
export const getSessionByBinding = Effect.fn("Session.getSessionByBinding")(
  function* (input: { readonly key: string }) {
    const { db } = yield* Database.Service;
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const bindingId = yield* sessionStore.findBinding(tx, input.key);
        if (!bindingId) return null;
        const { items } = yield* sessionStore.list(tx, { bindingId, limit: 1 });
        return items[0]
          ? Struct.omit(items[0], ["isActive", "isUnread"])
          : null;
      }),
    );
  },
);
