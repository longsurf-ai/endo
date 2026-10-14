// Purpose: Owns agent_run admission, atomic claim, and terminal transitions.

export * as AgentRunStore from "./store";

import type { AgentPromptInput as AgentPromptInputType } from "@openchart/server/agent/contracts/agent-prompt-input";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Publisher } from "@openchart/server/agent/publisher/publisher";

import {
  AgentRun,
  fromRow,
  ID as AgentRunID,
  type ID as AgentRunIDType,
} from "./run";
import { agentRun, agentSessions } from "@openchart/server/agent/schema";

type Client = Database.Interface["db"];
type StoreError = SqlError | EffectDrizzleQueryError;

/** Reads immutable admission/progress facts without acquiring queue mutation or publication capabilities.
 * @example const run = yield* readRun(runId);
 */
export const readRun = Effect.fn("AgentRunStore.readRun")(function* (
  id: AgentRunIDType,
) {
  const { db } = yield* Database.Service;
  return yield* get(db, id);
});

/**
 * Reads the oldest queued or running admission under a caller-owned intent
 * prefix. The prefix is literal, including SQL wildcard characters. Terminal
 * Runs are ignored; callers serialize the check with their own admission.
 * This owns no execution or cleanup and propagates database read failures.
 * @example const active = yield* activeRunByIntentPrefix(`collection:${id}:`);
 */
export const activeRunByIntentPrefix = Effect.fn(
  "AgentRunStore.activeRunByIntentPrefix",
)(function* (prefix: string) {
  const { db } = yield* Database.Service;
  const row = yield* db
    .select()
    .from(agentRun)
    .where(
      and(
        sql`substr(${agentRun.sessionIntentId}, 1, length(${prefix})) = ${prefix}`,
        inArray(agentRun.status, ["queued", "running"]),
      ),
    )
    .orderBy(asc(agentRun.createdAt), asc(agentRun.id))
    .get();
  return row ? fromRow(row) : undefined;
});

/** Reads executions matching a caller-owned intent prefix and any literal suffix, without admitting work.
 * @example yield* runsByIntent("trigger:", [":ale_example"]);
 */
export const runsByIntent = Effect.fn("AgentRunStore.runsByIntent")(function* (
  prefix: string,
  suffixes: readonly string[],
) {
  if (suffixes.length === 0) return [];
  const { db } = yield* Database.Service;
  const rows = yield* db
    .select({ run: agentRun, title: agentSessions.title })
    .from(agentRun)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRun.sessionId))
    .where(
      and(
        sql`substr(${agentRun.sessionIntentId}, 1, length(${prefix})) = ${prefix}`,
        sql`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(suffixes)}) AS suffix WHERE substr(${agentRun.sessionIntentId}, -length(suffix.value)) = suffix.value)`,
      ),
    )
    .orderBy(asc(agentRun.createdAt), asc(agentRun.id));
  return rows.map(({ run, title }) => ({ run: fromRow(run), title }));
});

/**
 * Fails abandoned running Runs through the normal failure/publication path,
 * then returns distinct Sessions with queued work. Call after transcript repair
 * and before execution starts. Each failure commits and publishes separately;
 * errors stop recovery, and retry skips already terminal Runs. Queued inputs
 * are preserved; interrupted Runs are never replayed.
 * @example
 * const queuedSessions = yield* AgentRunStore.recoverQueue();
 */
export const recoverQueue = Effect.fn("AgentRunStore.recoverQueue")(
  function* () {
    const { db } = yield* Database.Service;
    const runs = yield* Service;
    const running = yield* db
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(eq(agentRun.status, "running"));
    for (const row of running) {
      const id = yield* Schema.decodeUnknownEffect(AgentRunID)(row.id);
      yield* runs.fail(id);
    }
    const queued = yield* db
      .selectDistinct({ sessionID: agentRun.sessionId })
      .from(agentRun)
      .where(eq(agentRun.status, "queued"));
    return queued.map((row) => row.sessionID);
  },
);

/** Input accepted by {@link enqueue}. */
export interface EnqueueInput {
  readonly sessionID: string;
  readonly sessionIntentID: string;
  readonly input: AgentPromptInputType;
}

/**
 * Persists one immutable prompt as queued work.
 *
 * The target session must already exist; the database FK rejects admission
 * otherwise. This store never creates sessions.
 *
 * Replaying the same session intent returns its existing row. Reusing an
 * intent for another session or prompt is an invariant violation.
 *
 * @param input - Session envelope and canonical prompt input.
 * @returns The inserted or idempotently replayed run.
 */
const enqueue = Effect.fn("AgentRunStore.enqueue")(function* (
  db: Client,
  input: EnqueueInput,
) {
  const parsed = Schema.decodeUnknownSync(AgentRun.fields.input)(input.input);
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const stored = yield* tx
        .select()
        .from(agentRun)
        .where(eq(agentRun.sessionIntentId, input.sessionIntentID))
        .get();
      if (stored) return yield* replay(stored, input, parsed);

      const position = yield* tx
        .select({
          value: sql<number>`coalesce(max(${agentRun.queuePosition}), -1) + 1`,
        })
        .from(agentRun)
        .where(
          and(
            eq(agentRun.sessionId, input.sessionID),
            eq(agentRun.status, "queued"),
          ),
        )
        .get();
      if (!position) {
        return yield* Effect.die(
          `Agent run queue position was not returned: ${input.sessionID}`,
        );
      }

      const inserted = yield* tx
        .insert(agentRun)
        .values({
          id: AgentRunID.create(),
          sessionId: input.sessionID,
          sessionIntentId: input.sessionIntentID,
          input: parsed,
          status: "queued",
          queuePosition: position.value,
          createdAt: Date.now(),
        })
        .onConflictDoNothing({ target: agentRun.sessionIntentId })
        .returning()
        .get();
      if (inserted) return fromRow(inserted);

      const existing = yield* tx
        .select()
        .from(agentRun)
        .where(eq(agentRun.sessionIntentId, input.sessionIntentID))
        .get();
      if (!existing) {
        return yield* Effect.die(
          `Agent run intent disappeared: ${input.sessionIntentID}`,
        );
      }
      return yield* replay(existing, input, parsed);
    }),
  );
});

function replay(
  row: typeof agentRun.$inferSelect,
  input: EnqueueInput,
  parsed: AgentPromptInputType,
): Effect.Effect<AgentRun> {
  const run = fromRow(row);
  if (
    run.sessionID === input.sessionID &&
    JSON.stringify(run.input) === JSON.stringify(parsed)
  ) {
    return Effect.succeed(run);
  }
  return Effect.die(
    `Agent run intent was reused with different input: ${input.sessionIntentID}`,
  );
}

/**
 * Atomically claims the oldest queued run for one session.
 *
 * @param sessionID - Session whose queue should be drained.
 * @returns The running row, or `undefined` when the session is idle.
 */
const claim = Effect.fn("AgentRunStore.claim")(function* (
  db: Client,
  sessionID: string,
) {
  return yield* db.transaction((tx) =>
    Effect.gen(function* () {
      const running = yield* tx
        .select({ id: agentRun.id })
        .from(agentRun)
        .where(
          and(
            eq(agentRun.sessionId, sessionID),
            eq(agentRun.status, "running"),
          ),
        )
        .limit(1)
        .get();
      if (running) return undefined;

      const candidate = yield* tx
        .select({ id: agentRun.id })
        .from(agentRun)
        .where(
          and(eq(agentRun.sessionId, sessionID), eq(agentRun.status, "queued")),
        )
        .orderBy(asc(agentRun.queuePosition))
        .limit(1)
        .get();
      if (!candidate) return undefined;

      const claimed = yield* tx
        .update(agentRun)
        .set({
          status: "running",
          queuePosition: null,
          startedAt: Date.now(),
        })
        .where(
          and(eq(agentRun.id, candidate.id), eq(agentRun.status, "queued")),
        )
        .returning()
        .get();
      return claimed ? fromRow(claimed) : undefined;
    }),
  );
});

/**
 * Marks one running row terminal without changing its execution identity.
 *
 * @param id - Run to finish.
 * @returns The terminal run.
 */
const finish = Effect.fn("AgentRunStore.finish")(function* (
  db: Client,
  id: AgentRunIDType,
  status: "completed" | "stop" | "failed",
) {
  const time = yield* Clock.currentTimeMillis;
  const finished = yield* db
    .update(agentRun)
    .set({ status, finishedAt: time })
    .where(and(eq(agentRun.id, id), eq(agentRun.status, "running")))
    .returning()
    .get();
  if (finished) return fromRow(finished);
  return yield* Effect.die(`Running agent run not found: ${id}`);
});

/**
 * Reads one run by durable ID.
 *
 * @param id - Durable run ID.
 * @returns The run, or `undefined` when absent.
 */
const get = Effect.fn("AgentRunStore.get")(function* (
  db: Client,
  id: AgentRunIDType,
) {
  const row = yield* db
    .select()
    .from(agentRun)
    .where(eq(agentRun.id, id))
    .get();
  return row ? fromRow(row) : undefined;
});

const list = Effect.fn("AgentRunStore.list")(function* (
  db: Client,
  sessionID: string,
) {
  const rows = yield* db
    .select()
    .from(agentRun)
    .where(eq(agentRun.sessionId, sessionID))
    .orderBy(asc(agentRun.createdAt), asc(agentRun.id));
  return rows.map(fromRow);
});

const getByIntent = Effect.fn("AgentRunStore.getByIntent")(function* (
  db: Client,
  sessionIntentID: string,
) {
  const row = yield* db
    .select()
    .from(agentRun)
    .where(eq(agentRun.sessionIntentId, sessionIntentID))
    .get();
  return row ? fromRow(row) : undefined;
});

/** Durable agent-run persistence operations. */
export interface Interface {
  /**
   * Reads the accepted Session and immutable input for an idempotency key.
   * No Run is created or woken. Retry callers must reuse this saved request.
   * @example
   * const accepted = yield* store.getByIntent(sessionIntentID);
   */
  readonly getByIntent: (
    sessionIntentID: string,
  ) => Effect.Effect<AgentRun | undefined, StoreError>;
  /**
   * Reads a Session's durable runs in admission order for snapshot recovery.
   * @example
   * const runs = yield* store.list(sessionID);
   */
  readonly list: (sessionID: string) => Effect.Effect<AgentRun[], StoreError>;
  /**
   * Persists one immutable prompt as queued work.
   *
   * @param input - Session envelope and canonical prompt input.
   * @returns The inserted or idempotently replayed run.
   *
   * @example
   * ```ts
   * const run = yield* store.enqueue(request);
   * ```
   */
  readonly enqueue: (
    input: EnqueueInput,
  ) => Effect.Effect<AgentRun, StoreError>;
  /**
   * Atomically claims the oldest queued run for one session.
   *
   * @param sessionID - Session whose queue should be drained.
   * @returns The running row, or `undefined` when the session is idle.
   *
   * @example
   * ```ts
   * const run = yield* store.claim('session-1');
   * ```
   */
  readonly claim: (
    sessionID: string,
  ) => Effect.Effect<AgentRun | undefined, StoreError>;
  /**
   * Marks one running row completed.
   *
   * @param id - Run to finish.
   * @returns The completed run.
   *
   * @example
   * ```ts
   * const completed = yield* store.complete(run.id);
   * ```
   */
  readonly complete: (
    id: AgentRunIDType,
  ) => Effect.Effect<AgentRun, StoreError>;
  /**
   * Marks a running row stopped after interruption and successful cleanup.
   * Other states are rejected so a terminal outcome cannot be overwritten.
   *
   * @example
   * ```ts
   * yield* store.stop(run.id);
   * ```
   */
  readonly stop: (id: AgentRunIDType) => Effect.Effect<AgentRun, StoreError>;
  /**
   * Marks a running row failed after an error, defect, or startup recovery.
   * Other states are rejected so a terminal outcome cannot be overwritten.
   *
   * @example
   * ```ts
   * yield* store.fail(run.id);
   * ```
   */
  readonly fail: (id: AgentRunIDType) => Effect.Effect<AgentRun, StoreError>;
  /**
   * Reads one run by durable ID.
   *
   * @param id - Durable run ID.
   * @returns The run, or `undefined` when absent.
   *
   * @example
   * ```ts
   * const run = yield* store.get(id);
   * ```
   */
  readonly get: (
    id: AgentRunIDType,
  ) => Effect.Effect<AgentRun | undefined, StoreError>;
}

/** Agent-run persistence capability consumed by orchestration. */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/AgentRunStore",
) {}

/**
 * Supplies agent-run persistence from the application Database service.
 *
 * @example
 * ```ts
 * const storeLayer = AgentRunStore.layer.pipe(
 *   Layer.provide(databaseLayer),
 * );
 * ```
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service;
    const events = yield* Events.Service;
    const publisher = yield* Publisher.Service;
    const change = <A extends AgentRun | undefined>(
      effect: Effect.Effect<A, StoreError>,
      operation: Extract<
        Publisher.Change,
        { type: "run.updated" }
      >["operation"],
    ) =>
      events
        .withBarrier(
          Effect.gen(function* () {
            const run = yield* effect;
            if (!run) return run;
            yield* publisher.publish({
              type: "run.updated",
              operation,
              run,
              runs: yield* list(db, run.sessionID),
            });
            return run;
          }),
        )
        .pipe(Effect.uninterruptible);
    return Service.of({
      enqueue: (input) => change(enqueue(db, input), "enqueue"),
      claim: (sessionID) => change(claim(db, sessionID), "claim"),
      complete: (id) => change(finish(db, id, "completed"), "complete"),
      stop: (id) => change(finish(db, id, "stop"), "stop"),
      fail: (id) => change(finish(db, id, "failed"), "fail"),
      get: (id) => get(db, id),
      getByIntent: (intent) => getByIntent(db, intent),
      list: (sessionID) => list(db, sessionID),
    });
  }),
);
