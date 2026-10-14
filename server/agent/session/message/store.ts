// Purpose: Owns Message and Part SQL persistence and whole-message cursor pagination.

export * as MessageStore from "./store";

import { Buffer } from "node:buffer";
import {
  MessageInfo,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import { Part } from "@openchart/server/agent/contracts/part";
import { Session } from "@openchart/server/agent/contracts/session";
import {
  StoreNotFound,
  StoreWriteConflict,
} from "@openchart/server/agent/errors";
import {
  agentMessages,
  agentParts,
  agentSessions,
} from "@openchart/server/agent/schema";
import type { Database } from "@openchart/server/db";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Data from "./data";

/** Existing transaction shared by message, part, and enclosing lifecycle writes. */
export type Tx = Parameters<Parameters<Database.Client["transaction"]>[0]>[0];

/** Existing SQLite and schema failures exposed by persistence operations. */
export type StoreError =
  | SqlError
  | EffectDrizzleQueryError
  | Schema.SchemaError
  | StoreNotFound
  | StoreWriteConflict;

/** Message identity scoped to the Session being read. */
export interface MessageKey {
  readonly sessionID: MessageInfo["sessionID"];
  readonly messageID: MessageInfo["id"];
}

/** Part query scope; Session membership is checked through its owning Message. */
export interface PartKey extends MessageKey {
  readonly partID: Part["id"];
}

/** Older-history traversal within one Session, with complete Parts per message. */
export interface ListInput {
  readonly sessionID: MessageInfo["sessionID"];
  /** Opaque cursor returned for this Session; omit to read its latest page. */
  readonly cursor?: string;
  /** Positive integer maximum number of Messages, not Parts, to return. */
  readonly limit: number;
  /** Inclusive SQL creation-time upper bound in epoch milliseconds; omit for the current tail. */
  readonly throughCreatedAt?: number;
  /** Centers the page on this Message instead of starting at the latest; omit cursor. */
  readonly around?: MessageInfo["id"];
}

/** A bounded history page, with Messages returned oldest-first within the page. */
export interface Page {
  readonly items: readonly WithParts[];
  /** Continuation toward older Messages; null means no further page. */
  readonly nextCursor: string | null;
}

/** Complete visible turns, bounded by user messages rather than Part or byte counts. */
export interface TurnListInput {
  readonly sessionID: string;
  readonly turnLimit: number;
  readonly cursor?: string;
}

/** Sessions whose transcripts to scan for one substring. */
export interface MatchInput {
  readonly sessionIDs: readonly string[];
  readonly query: string;
}

// @agent invariant: SQL owns identity and membership; data.ts owns column-free
// payloads. Part Session membership comes only from its owning Message.
/**
 * Internal transcript storage contract, implemented by {@link messageStore}.
 *
 * Every method uses the caller's transaction without opening or committing one.
 * Reads reconstruct complete values from SQL columns and JSON before parsing
 * the shared contracts. Writes derive payloads through the existing data.ts
 * projections and preserve content timestamps independently of SQL row times.
 * Duplicate inserts, missing update targets, and ownership changes fail.
 * No method publishes events, invokes tools, or chooses model-loop transitions.
 */
export interface Interface {
  /** Deletes messages after the boundary in storage order, retaining the boundary.
   * Null deletes all messages. Parts cascade; missing/foreign boundaries fail.
   * The caller owns execution checks, related metadata, and publication.
   * @example yield* messageStore.truncate(tx, { sessionID, messageID });
   */
  readonly truncate: typeof truncate;
  /**
   * Reads a globally identified Message header without loading its Parts.
   * Internal operations use this to derive a Part's Session inside their write
   * transaction. Missing Messages return undefined; scoped public reads use get.
   *
   * @example
   * ```ts
   * const info = yield* messageStore.getInfo(tx, part.messageID);
   * ```
   */
  readonly getInfo: (
    tx: Tx,
    messageID: MessageInfo["id"],
  ) => Effect.Effect<MessageInfo | undefined, StoreError>;

  /**
   * Reads a Message and all its Parts in ascending Part ID order.
   * Returns undefined when no Message exists under the supplied Session.
   *
   * @example
   * ```ts
   * const store = messageStore;
   * const message = yield* store.get(tx, {
   *   sessionID: 'session-1', messageID: 'message-1',
   * });
   * ```
   */
  readonly get: (
    tx: Tx,
    key: MessageKey,
  ) => Effect.Effect<WithParts | undefined, StoreError>;

  /**
   * Selects Messages by SQL createdAt DESC, id DESC, then loads their Parts.
   * The cursor uses SQL row timestamps, not info.time.created. Each returned
   * page reverses the selected Messages into ascending order; Parts are ordered
   * by ID. Pagination never splits a Message or limits joined Part rows.
   * `around` centers a page on one Message: up to half the limit after it, the
   * rest at or before it, with the same continuation toward older Messages.
   * Invalid limits, malformed cursors, Session mismatches, and unknown
   * `around` Messages fail explicitly.
   *
   * @example
   * ```ts
   * const store = messageStore;
   * const page = yield* store.list(tx, {sessionID: 'session-1', limit: 20});
   * ```
   */
  readonly list: (tx: Tx, input: ListInput) => Effect.Effect<Page, StoreError>;

  /**
   * Reads up to turnLimit complete turns, newest page first and oldest-first
   * within each page. The cursor excludes its user boundary; new tail messages
   * cannot move older pages. Visibility comes from the stored Session kind:
   * a Dig In's copied prefix is never selected, and before its marker exists
   * it has no visible turns. Empty history returns no cursor. A leading
   * assistant-only prefix belongs to the oldest page. Message-count
   * pagination remains independent.
   * @example yield* messageStore.listTurns(tx, {sessionID, turnLimit: 10});
   */
  readonly listTurns: typeof listTurns;

  /**
   * Reads complete Messages with at least one Part whose stored JSON contains
   * the query, in transcript order. Callers project text and decide relevance.
   * @example
   * const hits = yield* messageStore.matches(tx, {sessionIDs: [id], query: "rates"});
   */
  readonly matches: typeof matches;

  /**
   * Inserts a Message and its initial Parts together in the supplied transaction.
   * All identities are caller-supplied and must be new. Every Part must name
   * this Message; Session membership follows it. An empty Parts array is allowed.
   *
   * @example
   * ```ts
   * const store = messageStore;
   * const saved = yield* store.insert(tx, {info: userMessage, parts: inputParts});
   * ```
   */
  readonly insert: (
    tx: Tx,
    message: WithParts,
  ) => Effect.Effect<WithParts, StoreError>;

  /**
   * Replaces an existing Message's content while preserving its ID, Session,
   * role, Parts, and SQL creation time. Records the SQL update time.
   * Assistant completion and its StepFinishPart must share the caller's
   * transaction, using this method together with insertPart.
   *
   * @example
   * ```ts
   * const store = messageStore;
   * const saved = yield* store.update(tx, completedAssistant);
   * ```
   */
  readonly update: typeof update;

  /**
   * Reads a Part under its Message, checking Session membership through that
   * Message. A missing match returns undefined.
   *
   * @example
   * ```ts
   * const store = messageStore;
   * const part = yield* store.getPart(tx, {
   *   sessionID: 'session-1', messageID: 'message-1', partID: 'part-1',
   * });
   * ```
   */
  readonly getPart: (
    tx: Tx,
    key: PartKey,
  ) => Effect.Effect<Part | undefined, StoreError>;

  /**
   * Inserts a new Part under an existing Message, which determines its Session.
   * Duplicate IDs and missing parent Messages fail before any change commits.
   *
   * @example
   * ```ts
   * const store = messageStore;
   * const saved = yield* store.insertPart(tx, textPart);
   * ```
   */
  readonly insertPart: typeof insertPart;

  /**
   * Replaces an existing Part's content and records its SQL update time.
   * ID, Message, Part type, and SQL creation time remain unchanged.
   * Tool-state transitions and immutable domain content remain caller-owned.
   *
   * @example
   * ```ts
   * const store = messageStore;
   * const saved = yield* store.updatePart(tx, completedToolPart);
   * ```
   */
  readonly updatePart: typeof updatePart;

  /**
   * Closes abandoned Assistant messages and active Parts across all Sessions.
   * Startup alone calls this before execution or observers exist. Completed
   * content and results survive; every write shares the caller's transaction.
   * @example
   * yield* messageStore.interruptUnfinished(tx, now);
   */
  readonly interruptUnfinished: typeof interruptUnfinished;
}

type MessageRow = typeof agentMessages.$inferSelect;
type PartRow = typeof agentParts.$inferSelect;
const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;

const truncate = Effect.fn("MessageStore.truncate")(function* (
  tx: Tx,
  input: { readonly sessionID: string; readonly messageID: string | null },
) {
  const boundary =
    input.messageID === null
      ? undefined
      : yield* tx
          .select({ id: agentMessages.id, createdAt: agentMessages.createdAt })
          .from(agentMessages)
          .where(
            and(
              eq(agentMessages.sessionId, input.sessionID),
              eq(agentMessages.id, input.messageID),
            ),
          )
          .get();
  if (input.messageID !== null && !boundary)
    return yield* new StoreNotFound({ entity: "message", id: input.messageID });
  yield* tx
    .delete(agentMessages)
    .where(
      and(
        eq(agentMessages.sessionId, input.sessionID),
        boundary === undefined
          ? undefined
          : or(
              gt(agentMessages.createdAt, boundary.createdAt),
              and(
                eq(agentMessages.createdAt, boundary.createdAt),
                gt(agentMessages.id, boundary.id),
              ),
            ),
      ),
    );
});
const PageLimit = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Cursor = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        kind: Schema.Literal("message"),
        sessionID: Schema.String,
        createdAt: Session.fields.createdAt,
        id: Schema.String,
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ),
  ),
);

const TurnCursor = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        kind: Schema.Literal("turn"),
        sessionID: Schema.String,
        createdAt: Session.fields.createdAt,
        id: Schema.String,
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ),
  ),
);

function decodeInfo(row: MessageRow) {
  return Schema.decodeUnknownEffect(MessageInfo)({
    ...row.data,
    id: row.id,
    sessionID: row.sessionId,
    role: row.role,
  });
}

function decodePart(row: PartRow) {
  return Schema.decodeUnknownEffect(Part)({
    ...row.data,
    id: row.id,
    messageID: row.messageId,
  });
}

function assemble(rows: readonly MessageRow[], parts: readonly PartRow[]) {
  return Effect.gen(function* () {
    const grouped = new Map<string, WithParts>();
    for (const row of rows)
      grouped.set(row.id, { info: yield* decodeInfo(row), parts: [] });
    for (const row of parts) {
      const message = grouped.get(row.messageId);
      assertExists(message, "Selected Part must belong to a selected Message");
      message.parts.push(yield* decodePart(row));
    }
    return [...grouped.values()];
  });
}

const getInfo = Effect.fn("MessageStore.getInfo")(function* (
  tx: Tx,
  messageID: MessageInfo["id"],
) {
  const row = yield* tx
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.id, messageID))
    .get();
  return row === undefined ? undefined : yield* decodeInfo(row);
});

const get = Effect.fn("MessageStore.get")(function* (tx: Tx, key: MessageKey) {
  const row = yield* tx
    .select()
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.id, key.messageID),
        eq(agentMessages.sessionId, key.sessionID),
      ),
    )
    .get();
  if (row === undefined) return undefined;
  const parts = yield* tx
    .select()
    .from(agentParts)
    .where(eq(agentParts.messageId, row.id))
    .orderBy(asc(agentParts.id));
  const [message] = yield* assemble([row], parts);
  assertExists(message, "An existing Message must produce one aggregate");
  return message;
});

/** SQL keyset position of one Message; ties on createdAt break by id. */
interface Position {
  readonly createdAt: number;
  readonly id: string;
}

function olderThan(position: Position) {
  return or(
    lt(agentMessages.createdAt, position.createdAt),
    and(
      eq(agentMessages.createdAt, position.createdAt),
      lt(agentMessages.id, position.id),
    ),
  );
}

function newerThan(position: Position) {
  return or(
    gt(agentMessages.createdAt, position.createdAt),
    and(
      eq(agentMessages.createdAt, position.createdAt),
      gt(agentMessages.id, position.id),
    ),
  );
}

const list = Effect.fn("MessageStore.list")(function* (
  tx: Tx,
  input: ListInput,
) {
  const limit = yield* Schema.decodeUnknownEffect(PageLimit)(input.limit);
  assertTrue(
    input.cursor === undefined || input.around === undefined,
    "A Message page starts from a cursor or around a Message, not both",
  );
  const scope = and(
    eq(agentMessages.sessionId, input.sessionID),
    input.throughCreatedAt === undefined
      ? undefined
      : lte(agentMessages.createdAt, input.throughCreatedAt),
  );
  const newestFirst = [desc(agentMessages.createdAt), desc(agentMessages.id)];
  const oldestFirst = [asc(agentMessages.createdAt), asc(agentMessages.id)];
  const rows = (where: SQL | undefined, order: SQL[], take: number) =>
    tx
      .select()
      .from(agentMessages)
      .where(where)
      .orderBy(...order)
      .limit(take);
  const ids = (where: SQL | undefined, order: SQL[], take: number) =>
    tx
      .select({ id: agentMessages.id })
      .from(agentMessages)
      .where(where)
      .orderBy(...order)
      .limit(take);

  // A centered page takes up to half the limit after its anchor; the anchor and
  // the remainder come from the older side, exactly like a latest or cursor page.
  let olderScope = scope;
  let newerScope: SQL | undefined;
  let newer: MessageRow[] = [];
  if (input.around !== undefined) {
    const anchor = (yield* rows(
      and(scope, eq(agentMessages.id, input.around)),
      newestFirst,
      1,
    ))[0];
    if (!anchor)
      return yield* new StoreNotFound({ entity: "message", id: input.around });
    newerScope = and(scope, newerThan(anchor));
    newer = yield* rows(newerScope, oldestFirst, Math.floor((limit - 1) / 2));
    olderScope = and(
      scope,
      or(eq(agentMessages.id, anchor.id), olderThan(anchor)),
    );
  } else if (input.cursor !== undefined) {
    const cursor = yield* Schema.decodeUnknownEffect(
      Cursor.check(
        Schema.makeFilter((value) => value.sessionID === input.sessionID, {
          message: "Message cursor must belong to the requested Session",
        }),
      ),
    )(input.cursor);
    olderScope = and(scope, olderThan(cursor));
  }
  const share = limit - newer.length;
  const older = yield* rows(olderScope, newestFirst, share + 1);
  const page = [...older.slice(0, share).reverse(), ...newer];
  // Limit Message IDs in subqueries, never joined Part rows or an unbounded IN list.
  const parts =
    page.length === 0
      ? []
      : yield* tx
          .select()
          .from(agentParts)
          .where(
            or(
              inArray(
                agentParts.messageId,
                ids(olderScope, newestFirst, share),
              ),
              newer.length === 0
                ? undefined
                : inArray(
                    agentParts.messageId,
                    ids(newerScope, oldestFirst, newer.length),
                  ),
            ),
          )
          .orderBy(asc(agentParts.id));
  const items = yield* assemble(page, parts);
  let nextCursor: string | null = null;
  if (older.length > share) {
    const last = older[share - 1];
    assertExists(last, "A Message continuation requires a nonempty page");
    nextCursor = yield* Schema.encodeEffect(Cursor)({
      kind: "message",
      sessionID: input.sessionID,
      createdAt: last.createdAt,
      id: last.id,
    });
  }
  return { items, nextCursor };
});

const listTurns = Effect.fn("MessageStore.listTurns")(function* (
  tx: Tx,
  input: TurnListInput,
) {
  const limit = yield* Schema.decodeUnknownEffect(PageLimit)(input.turnLimit);
  const cursor =
    input.cursor === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(
          TurnCursor.check(
            Schema.makeFilter((value) => value.sessionID === input.sessionID, {
              message: "Turn cursor must belong to the requested Session",
            }),
          ),
        )(input.cursor);
  const [session] = yield* tx
    .select({ kind: agentSessions.kind })
    .from(agentSessions)
    .where(eq(agentSessions.id, input.sessionID))
    .limit(1);
  let visibleFrom: Position | undefined;
  if (session?.kind === "dig_in") {
    // Resolve the boundary in SQL without assembling copied messages or returning
    // their attachment payloads. The marker is an existing ContextPart; until the
    // first child prompt commits it, the copied history stays hidden.
    const markers = yield* tx
      .select({
        id: agentMessages.id,
        createdAt: agentMessages.createdAt,
        role: agentMessages.role,
      })
      .from(agentMessages)
      .innerJoin(agentParts, eq(agentParts.messageId, agentMessages.id))
      .where(
        and(
          eq(agentMessages.sessionId, input.sessionID),
          sql`json_extract(${agentParts.data}, '$.type') = 'context'`,
          sql`json_extract(${agentParts.data}, '$.context.kind') = 'dig_in'`,
        ),
      )
      .limit(2);
    assertTrue(markers.length <= 1, "Dig In has multiple context markers");
    visibleFrom = markers[0];
    if (!visibleFrom) return { items: [], nextCursor: null };
    assertTrue(
      markers[0]!.role === "user",
      "Dig In marker must belong to a user message",
    );
  }
  const scope = and(
    eq(agentMessages.sessionId, input.sessionID),
    cursor === undefined ? undefined : olderThan(cursor),
    visibleFrom === undefined
      ? undefined
      : or(eq(agentMessages.id, visibleFrom.id), newerThan(visibleFrom)),
  );
  const starts = yield* tx
    .select({ id: agentMessages.id, createdAt: agentMessages.createdAt })
    .from(agentMessages)
    .where(and(scope, eq(agentMessages.role, "user")))
    .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
    .limit(limit + 1);
  const boundary = starts.length > limit ? starts[limit - 1] : undefined;
  const pageScope = and(
    scope,
    boundary === undefined
      ? undefined
      : or(eq(agentMessages.id, boundary.id), newerThan(boundary)),
  );
  const rows = yield* tx
    .select()
    .from(agentMessages)
    .where(pageScope)
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id));
  const parts =
    rows.length === 0
      ? []
      : yield* tx
          .select()
          .from(agentParts)
          .where(
            inArray(
              agentParts.messageId,
              tx
                .select({ id: agentMessages.id })
                .from(agentMessages)
                .where(pageScope),
            ),
          )
          .orderBy(asc(agentParts.id));
  return {
    items: yield* assemble(rows, parts),
    nextCursor:
      boundary === undefined
        ? null
        : yield* Schema.encodeEffect(TurnCursor)({
            kind: "turn",
            sessionID: input.sessionID,
            ...boundary,
          }),
  };
});

const insertPart = Effect.fn("MessageStore.insertPart")(function* <
  P extends Part,
>(tx: Tx, part: P) {
  const data = yield* Data.encodePart(part);
  const row = yield* tx
    .insert(agentParts)
    .values({ id: part.id, messageId: part.messageID, data })
    .returning()
    .get();
  assertExists(row, "Part insert must return its persisted row");
  // Encoding and decoding preserve the discriminator, not arbitrary refinements.
  return (yield* decodePart(row)) as Extract<Part, { type: P["type"] }>;
});

/**
 * Case-insensitive substring predicate over stored Part JSON; `%`, `_`, and
 * `\` in the query match literally. Session listings and matches share it.
 * @example
 * const where = transcriptLike("rates");
 */
export function transcriptLike(query: string) {
  const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
  return sql`${agentParts.data} LIKE ${`%${escaped}%`} ESCAPE '\\'`;
}

const matches = Effect.fn("MessageStore.matches")(function* (
  tx: Tx,
  input: MatchInput,
) {
  if (input.sessionIDs.length === 0) return [] as WithParts[];
  const rows = yield* tx
    .select()
    .from(agentMessages)
    .where(
      and(
        inArray(agentMessages.sessionId, input.sessionIDs),
        inArray(
          agentMessages.id,
          tx
            .select({ id: agentParts.messageId })
            .from(agentParts)
            .where(transcriptLike(input.query)),
        ),
      ),
    )
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id));
  if (rows.length === 0) return [];
  const parts = yield* tx
    .select()
    .from(agentParts)
    .where(
      inArray(
        agentParts.messageId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(agentParts.id));
  return yield* assemble(rows, parts);
});

const insert = Effect.fn("MessageStore.insert")(function* (
  tx: Tx,
  message: WithParts,
) {
  for (const part of message.parts) {
    if (part.messageID !== message.info.id)
      return yield* new StoreWriteConflict({
        entity: "part",
        id: part.id,
        field: "messageID",
        expected: message.info.id,
        actual: part.messageID,
      });
  }
  const data = yield* Data.encodeInfo(message.info);
  const row = yield* tx
    .insert(agentMessages)
    .values({
      id: message.info.id,
      sessionId: message.info.sessionID,
      role: message.info.role,
      data,
    })
    .returning()
    .get();
  assertExists(row, "Message insert must return its persisted row");
  const info = yield* decodeInfo(row);
  const parts: Part[] = [];
  for (const part of message.parts) parts.push(yield* insertPart(tx, part));
  // Reads and writes expose the same canonical Part order.
  parts.sort((left, right) =>
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id)),
  );
  return { info, parts };
});

const update = Effect.fn("MessageStore.update")(function* <
  I extends MessageInfo,
>(tx: Tx, info: I) {
  const current = yield* tx
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.id, info.id))
    .get();
  if (current === undefined)
    return yield* new StoreNotFound({ entity: "message", id: info.id });
  if (current.sessionId !== info.sessionID)
    return yield* new StoreWriteConflict({
      entity: "message",
      id: info.id,
      field: "sessionID",
      expected: current.sessionId,
      actual: info.sessionID,
    });
  if (current.role !== info.role)
    return yield* new StoreWriteConflict({
      entity: "message",
      id: info.id,
      field: "role",
      expected: current.role,
      actual: info.role,
    });
  const data = yield* Data.encodeInfo(info);
  const row = yield* tx
    .update(agentMessages)
    .set({ data, updatedAt: now })
    .where(eq(agentMessages.id, info.id))
    .returning()
    .get();
  assertExists(row, "An existing Message must return its updated row");
  // The role check above and unchanged SQL column preserve the input variant.
  return (yield* decodeInfo(row)) as Extract<MessageInfo, { role: I["role"] }>;
});

const getPart = Effect.fn("MessageStore.getPart")(function* (
  tx: Tx,
  key: PartKey,
) {
  const row = yield* tx
    .select({ part: agentParts })
    .from(agentParts)
    .innerJoin(agentMessages, eq(agentParts.messageId, agentMessages.id))
    .where(
      and(
        eq(agentParts.id, key.partID),
        eq(agentParts.messageId, key.messageID),
        eq(agentMessages.sessionId, key.sessionID),
      ),
    )
    .get();
  return row === undefined ? undefined : yield* decodePart(row.part);
});

const updatePart = Effect.fn("MessageStore.updatePart")(function* <
  P extends Part,
>(tx: Tx, part: P) {
  const current = yield* tx
    .select()
    .from(agentParts)
    .where(eq(agentParts.id, part.id))
    .get();
  if (current === undefined)
    return yield* new StoreNotFound({ entity: "part", id: part.id });
  if (current.messageId !== part.messageID)
    return yield* new StoreWriteConflict({
      entity: "part",
      id: part.id,
      field: "messageID",
      expected: current.messageId,
      actual: part.messageID,
    });
  const stored = yield* decodePart(current);
  if (stored.type !== part.type)
    return yield* new StoreWriteConflict({
      entity: "part",
      id: part.id,
      field: "type",
      expected: stored.type,
      actual: part.type,
    });
  const data = yield* Data.encodePart(part);
  const row = yield* tx
    .update(agentParts)
    .set({ data, updatedAt: now })
    .where(eq(agentParts.id, part.id))
    .returning()
    .get();
  assertExists(row, "An existing Part must return its updated row");
  // The type check above and canonical codec preserve the input variant.
  return (yield* decodePart(row)) as Extract<Part, { type: P["type"] }>;
});

const interruptUnfinished = Effect.fn("MessageStore.interruptUnfinished")(
  function* (tx: Tx, time: number) {
    const reason = "Execution interrupted by server restart";
    // Parts can outlive a terminal Run or Assistant when cleanup itself fails.
    // Sweep their own lifecycle states, including delegates, without guessing
    // a Run association or modifying ordinary untimed user text.
    const parts = yield* tx
      .select({ part: agentParts })
      .from(agentParts)
      .innerJoin(agentMessages, eq(agentParts.messageId, agentMessages.id))
      .where(
        and(
          eq(agentMessages.role, "assistant"),
          sql`(
            (json_extract(${agentParts.data}, '$.type') = 'tool'
              AND json_extract(${agentParts.data}, '$.state.status') IN ('pending', 'running'))
            OR (json_extract(${agentParts.data}, '$.type') IN ('text', 'reasoning')
              AND json_type(${agentParts.data}, '$.time') = 'object'
              AND json_extract(${agentParts.data}, '$.time.end') IS NULL)
          )`,
        ),
      );
    for (const row of parts) {
      const part = yield* decodePart(row.part);
      if (part.type === "tool") {
        const state = part.state;
        assertTrue(
          state.status === "pending" || state.status === "running",
          "Startup selected an inactive tool",
        );
        yield* updatePart(tx, {
          ...part,
          state: {
            status: "error",
            input: state.input,
            metadata: state.metadata,
            error: reason,
            time: {
              start: state.status === "running" ? state.time.start : time,
              end: time,
            },
          },
        });
        continue;
      }
      assertTrue(
        part.type === "text" || part.type === "reasoning",
        "Startup selected a non-streaming Part",
      );
      assertExists(part.time, "An abandoned stream must have a start time");
      yield* updatePart(tx, { ...part, time: { ...part.time, end: time } });
    }

    const messages = yield* tx
      .select()
      .from(agentMessages)
      .where(
        and(
          eq(agentMessages.role, "assistant"),
          sql`json_extract(${agentMessages.data}, '$.time.completed') IS NULL`,
        ),
      );
    for (const row of messages) {
      const info = yield* decodeInfo(row);
      assertTrue(info.role === "assistant", "Startup selected a User message");
      yield* update(tx, {
        ...info,
        error: info.error ?? {
          name: "MessageAbortedError",
          data: { message: reason },
        },
        time: { ...info.time, completed: time },
      });
    }
  },
);

/**
 * Provides real transcript persistence through caller-supplied transactions.
 * The Store owns no database connection, transaction boundary, or event service.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const {db} = yield* Database.Service;
 *   return yield* db.transaction(tx => messageStore.list(tx, {sessionID: 'session-1', limit: 20}));
 * });
 * ```
 */
export const messageStore: Interface = {
  truncate,
  getInfo,
  get,
  list,
  listTurns,
  matches,
  insert,
  update,
  getPart,
  insertPart,
  updatePart,
  interruptUnfinished,
};
