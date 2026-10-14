// Purpose: Persists backend-authored Occurrences and projects Session identity from their Runs.

import { agentRun } from "@openchart/server/agent/schema";
import type { ListFilter } from "@openchart/server/lib/resource/list-schema";
import { listWindowSql } from "@openchart/server/lib/resource/pagination-sql";
import type {
  Row,
  Store,
  StoreBody,
  Tx,
} from "@openchart/server/lib/resource/store";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { AgentScheduleOccurrenceEntity } from "./entity";
import { agentScheduleOccurrences } from "./schema";

type OccurrenceWrite = StoreBody<typeof AgentScheduleOccurrenceEntity>;

function selectOccurrence(tx: Tx) {
  return tx
    .select({ root: agentScheduleOccurrences, sessionId: agentRun.sessionId })
    .from(agentScheduleOccurrences)
    .leftJoin(agentRun, eq(agentRun.id, agentScheduleOccurrences.agentRunId));
}

function toRow(
  root: typeof agentScheduleOccurrences.$inferSelect,
  sessionId: string | null,
): Row {
  if (root.agentRunId !== null && sessionId === null)
    throw new Error(`Occurrence ${root.id} has no Run Session`);
  const { id, revision, createdAt, updatedAt, ...body } = root;
  return { id, revision, createdAt, updatedAt, body: { ...body, sessionId } };
}

function readWritten(tx: Tx, id: string, body: OccurrenceWrite) {
  return Effect.gen(function* () {
    const row = yield* selectOccurrence(tx)
      .where(eq(agentScheduleOccurrences.id, id))
      .get();
    if (!row) return yield* Effect.die("Occurrence write returned no row");
    // Session identity is a Run fact, even when backend callers supply a full body.
    if ("sessionId" in body && body.sessionId !== row.sessionId) {
      return yield* Effect.die("Occurrence sessionId must match its Run");
    }
    return toRow(row.root, row.sessionId);
  });
}

/** Full backend CRUD; the read-only API never narrows this Store. */
export const agentScheduleOccurrenceStore: Store<
  OccurrenceWrite,
  ListFilter<typeof AgentScheduleOccurrenceEntity>
> = {
  load: (tx, id) =>
    selectOccurrence(tx)
      .where(eq(agentScheduleOccurrences.id, id))
      .get()
      .pipe(
        Effect.map((row) => (row ? toRow(row.root, row.sessionId) : undefined)),
      ),
  list: (tx, filter, window) => {
    const page = listWindowSql(agentScheduleOccurrences, window);
    return selectOccurrence(tx)
      .where(
        and(
          page.where,
          filter.scheduleId === undefined
            ? undefined
            : eq(agentScheduleOccurrences.scheduleId, filter.scheduleId),
        ),
      )
      .orderBy(...page.orderBy)
      .limit(page.limit)
      .pipe(
        Effect.map((rows) => rows.map((row) => toRow(row.root, row.sessionId))),
      );
  },
  insert: (tx, input) =>
    Effect.gen(function* () {
      if (!("scheduleId" in input.body)) {
        return yield* Effect.die(
          "Occurrence creation requires backend provenance",
        );
      }
      yield* tx.insert(agentScheduleOccurrences).values({
        id: input.id,
        revision: input.revision,
        scheduleId: input.body.scheduleId,
        agentRunId: input.body.agentRunId,
        fireAt: input.body.fireAt,
      });
      return yield* readWritten(tx, input.id, input.body);
    }),
  save: (tx, id, input) =>
    Effect.gen(function* () {
      yield* tx
        .update(agentScheduleOccurrences)
        .set({
          revision: input.revision,
          ...("scheduleId" in input.body
            ? {
                scheduleId: input.body.scheduleId,
                agentRunId: input.body.agentRunId,
                fireAt: input.body.fireAt,
              }
            : {}),
        })
        .where(eq(agentScheduleOccurrences.id, id));
      return yield* readWritten(tx, id, input.body);
    }),
  remove: (tx, id) =>
    tx
      .delete(agentScheduleOccurrences)
      .where(eq(agentScheduleOccurrences.id, id))
      .pipe(Effect.asVoid),
};
