// Purpose: Resolves the Sessions that may observe a delegated interaction.
import type { Session } from "@openchart/server/agent/contracts/session";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { sessionStore } from "./store";
import { Database } from "@openchart/server/db";
import { assertTrue } from "@openchart/utils/assert";
import { Effect } from "effect";

/**
 * Returns the owner and its delegate ancestors, stopping at chats and branches.
 * Reads persisted ancestry in one transaction; missing owners fail explicitly.
 * @example const observers = yield* delegateObservers(sessionID);
 */
export const delegateObservers = Effect.fn("Session.delegateObservers")(
  function* (sessionID: string) {
    const { db } = yield* Database.Service;
    const result = yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const result = new Set<string>();
          let id: string | null = sessionID;
          while (id !== null) {
            assertTrue(!result.has(id), "Delegate ancestry must be acyclic");
            const session: Session | undefined = yield* sessionStore.get(
              tx,
              id,
            );
            if (!session) return { missing: id } as const;
            result.add(id);
            id = session.kind === "delegate" ? session.parentId : null;
          }
          return { observers: result } as const;
        }),
      )
      .pipe(Effect.orDie);
    if (result.missing !== undefined)
      return yield* new StoreNotFound({
        entity: "session",
        id: result.missing,
      });
    return result.observers;
  },
);
