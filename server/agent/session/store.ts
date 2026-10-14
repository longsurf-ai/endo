// Purpose: Owns Session and binding SQL, including cursor pagination, in caller-owned transactions.

export * as SessionStore from "./store";

import { Session } from "@openchart/server/agent/contracts/session";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { SessionListItem } from "./state";
import { ReadRunUnavailable } from "./errors";
import {
  agentMessages,
  agentParts,
  agentRun,
  agentSessionBindings,
  agentSessions,
} from "@openchart/server/agent/schema";
import { transcriptLike } from "@openchart/server/agent/session/message/store";
import type { Database } from "@openchart/server/db";
import { assertExists } from "@openchart/utils/assert";
import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNull,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Effect, Schema, Struct } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Existing transaction supplied by the operation that owns the Session change. */
export type Tx = Parameters<Parameters<Database.Client["transaction"]>[0]>[0];

/** Existing SQLite and schema failures exposed by persistence operations. */
export type StoreError =
  SqlError | EffectDrizzleQueryError | Schema.SchemaError | StoreNotFound;

/** Caller-supplied Session facts; SQLite supplies initial row timestamps. */
export type InsertInput = Readonly<
  Omit<Session, "createdAt" | "updatedAt" | "lastReadRunId">
>;

/** Omitted fields stay unchanged; explicit null clears a nullable field. */
export type UpdateInput = Readonly<Partial<Omit<InsertInput, "id">>>;

type BindingInput = Readonly<
  Pick<typeof agentSessionBindings.$inferInsert, "id" | "key">
>;

/** Existing Session timestamps available for directory ordering. */
export const OrderBy = Schema.Literals(["createdAt", "updatedAt"]);

/**
 * Filters and continuation for a newest-first Session listing.
 * Omitted filters match all values; null selects root or unbound Sessions.
 */
export interface ListInput {
  /** Matches any selected kind; an empty selection matches no Sessions. */
  readonly kinds?: readonly Session["kind"][];
  readonly parentId?: Session["parentId"];
  readonly bindingId?: Session["bindingId"];
  /** Directory callers hide archived Sessions; internal reads include them by default. */
  readonly excludeArchived?: boolean;
  /** Keeps only Sessions whose transcript Part JSON contains this substring, case-insensitively. */
  readonly transcriptContains?: string;
  /** Defaults to creation order; directory callers select recent updates. */
  readonly orderBy?: typeof OrderBy.Type;
  /** Opaque cursor returned for the same filters; omit for the first page. */
  readonly cursor?: string;
  /** Positive integer maximum number of Sessions to return. */
  readonly limit: number;
}

/** One page ordered by the selected timestamp descending, then id descending. */
export interface Page {
  readonly items: readonly (typeof SessionListItem.Type)[];
  /** Continuation toward older Sessions; null means no further page. */
  readonly nextCursor: string | null;
}

// @agent invariant: Session contracts come from server/agent/contracts. Stores receive
// caller-owned transactions and identities; they never create execution state.
/**
 * Internal Session storage contract, implemented by {@link sessionStore}.
 *
 * Every method uses the caller's transaction without opening or committing one.
 * Reads parse the complete stored Session at the database boundary. Duplicate
 * Session inserts and updates of missing Sessions fail rather than silently upserting.
 * Binding rotation, branch creation, defaults, and event publication remain
 * with the calling operation. This contract exposes no deletion operation.
 */
export interface Interface {
  /** Advance the observed ended Run's Session without touching directory ordering; older marks are no-ops. @example yield* sessionStore.markRead(tx, runId); */
  readonly markRead: typeof markRead;
  /** Read a slot without creating it. @example const id = yield* sessionStore.findBinding(tx, key); */
  readonly findBinding: typeof findBinding;
  /** Checks durable queued/running work inside the caller's transaction.
   * @example if (yield* sessionStore.hasActiveRun(tx, id)) return yield* new SessionBusy();
   */
  readonly hasActiveRun: typeof hasActiveRun;
  /**
   * Inserts a binding key if absent and returns its persisted ID.
   * An existing key keeps its identity; the caller supplies the ID for a new key.
   * Session selection and creation remain with the calling operation.
   * @example
   * const bindingId = yield* sessionStore.ensureBinding(tx, {id, key});
   */
  readonly ensureBinding: (
    tx: Tx,
    input: BindingInput,
  ) => Effect.Effect<string, StoreError>;

  /**
   * Reads a Session, returning undefined only when its ID is absent.
   *
   * @example
   * ```ts
   * const store = sessionStore;
   * const session = yield* store.get(tx, 'ses_example');
   * ```
   */
  readonly get: (
    tx: Tx,
    id: typeof Session.fields.id.Encoded,
  ) => Effect.Effect<Session | undefined, StoreError>;

  /**
   * Reads a bounded page by the selected timestamp DESC, id DESC.
   * Each item includes activity derived from its queued or running Runs.
   * Cursor traversal preserves the order and filters without offset pagination.
   * Invalid limits, malformed cursors, and filter mismatches fail explicitly.
   *
   * @example
   * ```ts
   * const store = sessionStore;
   * const page = yield* store.list(tx, {parentId: null, limit: 20});
   * ```
   */
  readonly list: (tx: Tx, input: ListInput) => Effect.Effect<Page, StoreError>;

  /**
   * Inserts the supplied Session identity and facts, returning row timestamps.
   * The caller supplies explicit nulls and chooses the title and relationships.
   * An existing ID is a failure, even when its stored content matches.
   *
   * @example
   * ```ts
   * const store = sessionStore;
   * const session = yield* store.insert(tx, {
   *   id: Session.fields.id.make('ses_example'), parentId: null, kind: "chat", bindingId: null,
   *   anchors: null, title: 'Analysis',
   *   compactingAt: null, archivedAt: null,
   * });
   * ```
   */
  readonly insert: (
    tx: Tx,
    input: InsertInput,
  ) => Effect.Effect<Session, StoreError>;

  /**
   * Updates selected facts of an existing Session and records updatedAt.
   * Its ID and createdAt remain unchanged. The caller owns any cross-row
   * checks and writes required by binding or anchor changes in this transaction.
   *
   * @example
   * ```ts
   * const store = sessionStore;
   * const session = yield* store.update(tx, 'ses_example', {title: 'Summary'});
   * ```
   */
  readonly update: (
    tx: Tx,
    id: typeof Session.fields.id.Encoded,
    changes: UpdateInput,
  ) => Effect.Effect<Session, StoreError>;
}

const writableFields = Struct.keys(
  Struct.omit(Session.fields, [
    "id",
    "createdAt",
    "updatedAt",
    "lastReadRunId",
  ]),
);
const now = sql`(CAST(unixepoch('subsec') * 1000 AS INTEGER))`;
const decodeSession = Schema.decodeUnknownEffect(Session);
const PageLimit = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThan(Number.MAX_SAFE_INTEGER),
);
const Cursor = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        kind: Schema.Literal("session"),
        sessionKinds: Schema.optional(Schema.Array(Session.fields.kind)),
        orderBy: OrderBy,
        timestamp: Session.fields.createdAt,
        id: Session.fields.id,
        parentId: Schema.optional(Session.fields.parentId),
        bindingId: Schema.optional(Session.fields.bindingId),
        excludeArchived: Schema.Boolean,
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
    ),
  ),
);

const ensureBinding = Effect.fn("SessionStore.ensureBinding")(function* (
  tx: Tx,
  input: BindingInput,
) {
  yield* tx
    .insert(agentSessionBindings)
    .values(input)
    .onConflictDoNothing({ target: agentSessionBindings.key });
  const binding = yield* tx
    .select({ id: agentSessionBindings.id })
    .from(agentSessionBindings)
    .where(eq(agentSessionBindings.key, input.key))
    .get();
  assertExists(binding, "A binding must exist after insertion or replay");
  return binding.id;
});

const findBinding = Effect.fn("SessionStore.findBinding")(function* (
  tx: Tx,
  key: string,
) {
  const binding = yield* tx
    .select({ id: agentSessionBindings.id })
    .from(agentSessionBindings)
    .where(eq(agentSessionBindings.key, key))
    .get();
  return binding?.id;
});

const get = Effect.fn("SessionStore.get")(function* (
  tx: Tx,
  id: typeof Session.fields.id.Encoded,
) {
  const row = yield* tx
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .get();
  return row === undefined ? undefined : yield* decodeSession(row);
});

const hasActiveRun = Effect.fn("SessionStore.hasActiveRun")(function* (
  tx: Tx,
  sessionID: string,
) {
  const row = yield* tx
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(
      and(
        eq(agentRun.sessionId, sessionID),
        inArray(agentRun.status, ["queued", "running"]),
      ),
    )
    .limit(1)
    .get();
  return row !== undefined;
});

const list = Effect.fn("SessionStore.list")(function* (
  tx: Tx,
  input: ListInput,
) {
  const limit = yield* Schema.decodeUnknownEffect(PageLimit)(input.limit);
  const orderBy = input.orderBy ?? "createdAt";
  const excludeArchived = input.excludeArchived ?? false;
  // A cursor follows the selected set regardless of input order or duplicates.
  const kinds =
    input.kinds === undefined ? undefined : [...new Set(input.kinds)].sort();
  const timestamp = agentSessions[orderBy];
  const cursor =
    input.cursor === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(
          Cursor.check(
            Schema.makeFilter(
              (value) =>
                value.orderBy === orderBy &&
                value.sessionKinds?.join(",") === kinds?.join(",") &&
                value.parentId === input.parentId &&
                value.bindingId === input.bindingId &&
                value.excludeArchived === excludeArchived,
              {
                message:
                  "Session cursor order and filters must match the listing",
              },
            ),
          ),
        )(input.cursor);
  const rows = yield* tx
    .select({
      ...getTableColumns(agentSessions),
      isActive: exists(
        tx
          .select({ id: agentRun.id })
          .from(agentRun)
          .where(
            and(
              eq(agentRun.sessionId, agentSessions.id),
              inArray(agentRun.status, ["queued", "running"]),
            ),
          ),
      ).mapWith(Boolean),
      isUnread: exists(
        tx
          .select({ id: agentRun.id })
          .from(agentRun)
          .where(
            and(
              eq(agentRun.sessionId, agentSessions.id),
              isNotNull(agentRun.finishedAt),
              or(
                isNull(agentSessions.lastReadRunId),
                gt(agentRun.id, agentSessions.lastReadRunId),
              ),
            ),
          ),
      ).mapWith(Boolean),
    })
    .from(agentSessions)
    .where(
      and(
        excludeArchived ? isNull(agentSessions.archivedAt) : undefined,
        kinds === undefined ? undefined : inArray(agentSessions.kind, kinds),
        input.parentId === undefined
          ? undefined
          : input.parentId === null
            ? isNull(agentSessions.parentId)
            : eq(agentSessions.parentId, input.parentId),
        input.bindingId === undefined
          ? undefined
          : input.bindingId === null
            ? isNull(agentSessions.bindingId)
            : eq(agentSessions.bindingId, input.bindingId),
        input.transcriptContains === undefined
          ? undefined
          : exists(
              tx
                .select({ id: agentParts.id })
                .from(agentParts)
                .innerJoin(
                  agentMessages,
                  eq(agentMessages.id, agentParts.messageId),
                )
                .where(
                  and(
                    eq(agentMessages.sessionId, agentSessions.id),
                    transcriptLike(input.transcriptContains),
                  ),
                ),
            ),
        cursor === undefined
          ? undefined
          : or(
              lt(timestamp, cursor.timestamp),
              and(
                eq(timestamp, cursor.timestamp),
                lt(agentSessions.id, cursor.id),
              ),
            ),
      ),
    )
    .orderBy(desc(timestamp), desc(agentSessions.id))
    .limit(limit + 1);
  const items = yield* Effect.forEach(rows.slice(0, limit), (row) =>
    Schema.decodeUnknownEffect(SessionListItem)(row),
  );
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = items.at(-1);
    assertExists(last, "A Session continuation requires a nonempty page");
    nextCursor = yield* Schema.encodeEffect(Cursor)({
      kind: "session",
      ...(kinds === undefined ? {} : { sessionKinds: kinds }),
      orderBy,
      excludeArchived,
      timestamp: last[orderBy],
      id: last.id,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.bindingId === undefined ? {} : { bindingId: input.bindingId }),
    });
  }
  return { items, nextCursor };
});

const insert = Effect.fn("SessionStore.insert")(function* (
  tx: Tx,
  input: InsertInput,
) {
  const row = yield* tx
    .insert(agentSessions)
    .values(Struct.pick(input, ["id", ...writableFields]))
    .returning()
    .get();
  assertExists(row, "Session insert must return its persisted row");
  return yield* decodeSession(row);
});

const update = Effect.fn("SessionStore.update")(function* (
  tx: Tx,
  id: typeof Session.fields.id.Encoded,
  changes: UpdateInput,
) {
  const row = yield* tx
    .update(agentSessions)
    .set({
      ...Struct.pick(changes, writableFields),
      updatedAt: now,
    })
    .where(eq(agentSessions.id, id))
    .returning()
    .get();
  if (row === undefined)
    return yield* new StoreNotFound({ entity: "session", id });
  return yield* decodeSession(row);
});

const markRead = Effect.fn("SessionStore.markRead")(function* (
  tx: Tx,
  runId: string,
) {
  const run = yield* tx
    .select({ sessionId: agentRun.sessionId })
    .from(agentRun)
    .where(and(eq(agentRun.id, runId), isNotNull(agentRun.finishedAt)))
    .get();
  if (!run) return yield* new ReadRunUnavailable();
  const row = yield* tx
    .update(agentSessions)
    .set({ lastReadRunId: runId })
    .where(
      and(
        eq(agentSessions.id, run.sessionId),
        or(
          isNull(agentSessions.lastReadRunId),
          lt(agentSessions.lastReadRunId, runId),
        ),
      ),
    )
    .returning()
    .get();
  return row === undefined ? undefined : yield* decodeSession(row);
});

/**
 * Provides real SQL persistence using the transaction supplied to each call.
 * The Store owns no connection, transaction boundary, or event subscription.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const {db} = yield* Database.Service;
 *   return yield* db.transaction(tx => sessionStore.get(tx, 'ses_example'));
 * });
 * ```
 */
export const sessionStore: Interface = {
  markRead,
  hasActiveRun,
  ensureBinding,
  findBinding,
  get,
  list,
  insert,
  update,
};
