// Purpose: Searches every Session transcript for a substring and returns sessions with matching snippets.

import { transcriptText } from "@openchart/server/agent/session/message/transcript-text";
import { Session } from "@openchart/server/agent/session/session";
import * as Tool from "@openchart/server/agent/tool/tool";
import { Effect, Schema } from "effect";
import { InvalidCursor } from "./errors";

/** Sessions per page when the model omits limit. */
export const DEFAULT_PAGE_LIMIT = 10;
/** Upper bound on sessions per page. */
export const MAX_PAGE_LIMIT = 20;
/** Snippets kept per session; read_transcript shows the rest. */
export const MAX_MATCHES_PER_SESSION = 5;
const SNIPPET_RADIUS = 80;

/** Model-facing arguments; cursor is omitted on the first call. */
export const Parameters = Schema.Struct({
  query: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(200),
  ).annotate({
    description: "Case-insensitive substring to find in session transcripts.",
  }),
  cursor: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2048),
    ).annotate({
      description:
        "Omit on the first call. Pass the exact nextCursor from the previous page for more sessions.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LIMIT }),
    ).annotate({
      description: `Maximum sessions per page. Defaults to ${DEFAULT_PAGE_LIMIT} and is capped at ${MAX_PAGE_LIMIT}.`,
    }),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Execution facts for the tool card; the model reads the JSON output instead. */
export type Metadata = {
  query: string;
  sessions: number;
  hasMore: boolean;
  nextCursor: string | null;
};

/**
 * The first case-insensitive occurrence of query in text with surrounding
 * context and collapsed whitespace; undefined when text lacks the query.
 * @example
 * const excerpt = snippet(yield* transcriptText(message), "rates");
 */
export function snippet(text: string, query: string): string | undefined {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return undefined;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + query.length + SNIPPET_RADIUS);
  const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

/**
 * Finds prior Sessions by transcript content so the model can read them.
 *
 * Storage pre-filters on stored Part JSON; a session is reported only when
 * the query also appears in the text read_transcript would show, so hits in
 * bookkeeping such as tool titles or reasoning never surface. The caller's
 * own Session is excluded. Every Session kind is included and labelled.
 *
 * Output is `{type: "json"}`:
 * ```json
 * {
 *   "items": [{
 *     "sessionId": "ses_…", "title": "Rates outlook", "kind": "chat",
 *     "updatedAt": "2026-09-18T12:00:00.000Z",
 *     "matches": [{"messageId": "msg_…", "role": "user", "snippet": "…rates…"}]
 *   }],
 *   "nextCursor": null
 * }
 * ```
 * @example
 * const tool = yield* Tool.init(yield* SearchTranscriptTool);
 * const page = yield* tool.execute({query: 'rates'}, context);
 */
export const SearchTranscriptTool = Tool.define(
  "search_transcript",
  Effect.succeed({
    description:
      "Search every saved agent session transcript for a case-insensitive substring. Returns sessions most recently updated first, each with its kind, title, and up to five matching snippets; the current session is excluded. Use read_transcript with a returned sessionId to read the full transcript. Omit cursor on the first call and pass the returned nextCursor unchanged for more sessions.",
    parameters: Parameters,
    execute: Effect.fn("SearchTranscript.execute")(function* (
      input: typeof Parameters.Type,
      ctx: Tool.Context<Metadata>,
    ) {
      yield* ctx.ask({
        permission: "search_transcript",
        patterns: [input.query],
        always: ["*"],
        metadata: { query: input.query },
      });
      const sessions = yield* Session.Service;
      const page = yield* sessions
        .searchTranscripts({
          query: input.query,
          limit: input.limit ?? DEFAULT_PAGE_LIMIT,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })
        .pipe(
          // Storage rejects unknown cursors while decoding them; stored rows
          // were parsed on write, so a decode failure here is the cursor.
          Effect.catchTag("SchemaError", (error) =>
            Effect.fail(
              input.cursor === undefined
                ? error
                : new InvalidCursor({ tool: "search_transcript" }),
            ),
          ),
        );
      const items = [];
      for (const { session, matches } of page.items) {
        if (session.id === ctx.sessionID) continue;
        const snippets = [];
        for (const message of matches) {
          const text = yield* transcriptText(message);
          const excerpt = snippet(text, input.query);
          if (excerpt === undefined) continue;
          snippets.push({
            messageId: message.info.id,
            role: message.info.role,
            snippet: excerpt,
          });
          if (snippets.length === MAX_MATCHES_PER_SESSION) break;
        }
        if (snippets.length === 0) continue;
        items.push({
          sessionId: session.id,
          title: session.title,
          kind: session.kind,
          updatedAt: new Date(session.updatedAt).toISOString(),
          matches: snippets,
        });
      }
      return {
        title: "Search transcripts",
        metadata: {
          query: input.query,
          sessions: items.length,
          hasMore: page.nextCursor !== null,
          nextCursor: page.nextCursor,
        },
        output: {
          type: "json" as const,
          value: { items, nextCursor: page.nextCursor },
        },
      };
    }),
  }),
);
