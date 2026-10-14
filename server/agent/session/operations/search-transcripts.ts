// Purpose: Pages Sessions whose transcripts contain a substring, with complete matching messages.

import type { WithParts } from "@openchart/server/agent/contracts/message";
import { messageStore } from "@openchart/server/agent/session/message/store";
import {
  sessionStore,
  type SessionStore,
} from "@openchart/server/agent/session/store";
import { Database } from "@openchart/server/db";
import { Effect } from "effect";

/** Substring query with the Session store's page size and cursor. */
export interface SearchTranscriptsInput {
  readonly query: string;
  readonly limit: number;
  readonly cursor?: string;
}

/** Matching Sessions, most recently updated first, each with complete candidate messages in transcript order. */
export interface SearchTranscriptsPage {
  readonly items: readonly {
    readonly session: SessionStore.Page["items"][number];
    readonly matches: readonly WithParts[];
  }[];
  readonly nextCursor: string | null;
}

/**
 * Lists Sessions with at least one transcript match by `updatedAt DESC, id DESC`,
 * then reads complete matching messages of that page in one transaction. The query is
 * a case-insensitive substring over stored Part JSON; callers project text.
 * @example
 * const page = yield* searchTranscripts({query: 'rates', limit: 10});
 */
export const searchTranscripts = Effect.fn("Session.searchTranscripts")(
  function* (input: SearchTranscriptsInput) {
    const { db } = yield* Database.Service;
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const page = yield* sessionStore.list(tx, {
          orderBy: "updatedAt",
          limit: input.limit,
          transcriptContains: input.query,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        });
        const matches = yield* messageStore.matches(tx, {
          sessionIDs: page.items.map((session) => session.id),
          query: input.query,
        });
        const result: SearchTranscriptsPage = {
          items: page.items.map((session) => ({
            session,
            matches: matches.filter(
              (match) => match.info.sessionID === session.id,
            ),
          })),
          nextCursor: page.nextCursor,
        };
        return result;
      }),
    );
  },
);
