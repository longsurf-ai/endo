// Purpose: Persists Schedule definitions and maintains their backend-owned recurrence cursor.

import { listWindowSql } from "@openchart/server/lib/resource/pagination-sql";
import type {
  Row,
  Store,
  StoreBody,
} from "@openchart/server/lib/resource/store";
import { eq } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { AgentScheduleEntity } from "./entity";
import { nextScheduleFire } from "./recurrence";
import { agentSchedules, AgentScheduleRecurrence } from "./schema";

type ScheduleWrite = StoreBody<typeof AgentScheduleEntity>;

function toRow(row: typeof agentSchedules.$inferSelect): Row {
  const { id, revision, createdAt, updatedAt, ...body } = row;
  return { id, revision, createdAt, updatedAt, body };
}

const sameRecurrence = Schema.toEquivalence(AgentScheduleRecurrence);

/** Full Schedule persistence; client writes derive the cursor, internal writes may supply it. */
export const agentScheduleStore: Store<ScheduleWrite> = {
  load: (tx, id) =>
    tx
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.id, id))
      .get()
      .pipe(Effect.map((row) => (row ? toRow(row) : undefined))),
  list: (tx, _filter, window) => {
    const page = listWindowSql(agentSchedules, window);
    return tx
      .select()
      .from(agentSchedules)
      .where(page.where)
      .orderBy(...page.orderBy)
      .limit(page.limit)
      .pipe(Effect.map((rows) => rows.map(toRow)));
  },
  insert: (tx, input) =>
    Effect.gen(function* () {
      const nextFireAt =
        "nextFireAt" in input.body
          ? input.body.nextFireAt
          : yield* nextScheduleFire(input.body.recurrence);
      const row = yield* tx
        .insert(agentSchedules)
        .values({
          ...input.body,
          id: input.id,
          revision: input.revision,
          nextFireAt,
        })
        .returning()
        .get();
      if (!row) return yield* Effect.die("Schedule insert returned no row");
      return toRow(row);
    }),
  save: (tx, id, input) =>
    Effect.gen(function* () {
      const current = yield* tx
        .select()
        .from(agentSchedules)
        .where(eq(agentSchedules.id, id))
        .get();
      if (!current)
        return yield* Effect.die("Schedule disappeared during save");
      // Renames and pauses never advance the cursor. Re-enabling or changing the
      // recurrence restarts it from now unless a backend operation supplies it.
      const nextFireAt =
        "nextFireAt" in input.body
          ? input.body.nextFireAt
          : !sameRecurrence(current.recurrence, input.body.recurrence) ||
              (!current.enabled && input.body.enabled)
            ? yield* nextScheduleFire(input.body.recurrence)
            : current.nextFireAt;
      const row = yield* tx
        .update(agentSchedules)
        .set({
          ...input.body,
          revision: input.revision,
          nextFireAt,
        })
        .where(eq(agentSchedules.id, id))
        .returning()
        .get();
      if (!row) return yield* Effect.die("Schedule save returned no row");
      return toRow(row);
    }),
  remove: (tx, id) =>
    tx
      .delete(agentSchedules)
      .where(eq(agentSchedules.id, id))
      .pipe(Effect.asVoid),
};
