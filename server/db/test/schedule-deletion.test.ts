// Purpose: Proves Schedule deletion removes only its Occurrences and preserves Agent execution history.

import {
  agentMessages,
  agentParts,
  agentRun,
  agentSessions,
} from "@openchart/server/agent/schema";
import { Database } from "@openchart/server/db";
import { agentScheduleOccurrences } from "@openchart/server/resources/agent-schedule-occurrence/schema";
import { agentSchedules } from "@openchart/server/resources/agent-schedule/schema";
import { sql } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { expect, test } from "vitest";

const input = {
  agent: "analyst",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text" as const, text: "Research the watchlist." }],
};
const target = { kind: "agent_prompt" as const, prompt: input };
const recurrence = {
  kind: "once" as const,
  fireAt: "2026-09-11T00:00:00.000Z",
};

function seedAgentHistory(db: Database.Client) {
  return db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx.insert(agentSessions).values({
        kind: "chat",
        id: "ses_shared",
        title: "Shared scheduled research",
        createdAt: 100,
        updatedAt: 200,
      });
      yield* tx.insert(agentMessages).values({
        id: "msg_history",
        sessionId: "ses_shared",
        role: "user",
        data: {
          time: { created: 100 },
          agent: input.agent,
          model: input.model,
        },
        createdAt: 100,
        updatedAt: 200,
      });
      yield* tx.insert(agentParts).values({
        id: "prt_history",
        messageId: "msg_history",
        data: { type: "text", text: "Research the schedule." },
        createdAt: 100,
        updatedAt: 200,
      });
      for (const [index, name] of ["live", "paused", "deleted"].entries()) {
        yield* tx.insert(agentRun).values({
          id: `agr_${name}`,
          sessionId: "ses_shared",
          sessionIntentId: `scheduled-${name}`,
          input,
          status: index === 0 ? "running" : "queued",
          queuePosition: index === 0 ? null : index,
          createdAt: 100,
          startedAt: index === 0 ? 200 : null,
        });
      }
    }),
  );
}

function readAgentHistory(db: Database.Client) {
  return Effect.gen(function* () {
    return {
      sessions: yield* db
        .select()
        .from(agentSessions)
        .orderBy(agentSessions.id),
      runs: yield* db.select().from(agentRun).orderBy(agentRun.id),
      messages: yield* db
        .select()
        .from(agentMessages)
        .orderBy(agentMessages.id),
      parts: yield* db.select().from(agentParts).orderBy(agentParts.id),
    };
  });
}

test("fresh-schema deletion cascades only Occurrences, rolls back atomically, and publishes committed invalidations", async () => {
  const changes: Database.Change[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* seedAgentHistory(db);
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          for (const name of ["live", "paused"]) {
            yield* tx.insert(agentSchedules).values({
              id: `ags_${name}`,
              name,
              enabled: name === "live",
              target,
              recurrence,
              nextFireAt: 400,
              revision: 7,
            });
            yield* tx.insert(agentScheduleOccurrences).values({
              id: `aso_${name}`,
              scheduleId: `ags_${name}`,
              agentRunId: `agr_${name}`,
              fireAt: 150,
              revision: 3,
            });
          }
        }),
      );
      const history = yield* readAgentHistory(db);
      const schedules = yield* db
        .select()
        .from(agentSchedules)
        .orderBy(agentSchedules.id);
      const occurrences = yield* db
        .select()
        .from(agentScheduleOccurrences)
        .orderBy(agentScheduleOccurrences.id);
      changes.length = 0;

      const rolledBack = yield* Effect.exit(
        db.transaction((tx) =>
          tx
            .run(sql`DELETE FROM agent_schedule WHERE id = 'ags_live'`)
            .pipe(Effect.andThen(Effect.fail("cancel deletion"))),
        ),
      );
      expect(Exit.isFailure(rolledBack)).toBe(true);
      expect(changes).toEqual([]);
      expect(
        yield* db.select().from(agentSchedules).orderBy(agentSchedules.id),
      ).toEqual(schedules);
      expect(
        yield* db
          .select()
          .from(agentScheduleOccurrences)
          .orderBy(agentScheduleOccurrences.id),
      ).toEqual(occurrences);
      yield* db.transaction((tx) =>
        tx.run(sql`DELETE FROM agent_schedule WHERE id = 'ags_live'`),
      );
      expect(yield* db.select().from(agentSchedules)).toEqual(
        schedules.filter((schedule) => schedule.id === "ags_paused"),
      );
      expect(yield* db.select().from(agentScheduleOccurrences)).toEqual(
        occurrences.filter((occurrence) => occurrence.id === "aso_paused"),
      );
      expect(yield* readAgentHistory(db)).toEqual(history);
      expect(changes).toEqual([
        { table: "agent_schedule", id: "ags_live", revision: 7 },
        { table: "agent_schedule_occurrence", id: "aso_live", revision: 3 },
      ]);
      for (const statement of [
        sql`DELETE FROM agent_run WHERE id = 'agr_paused'`,
        sql`DELETE FROM agent_sessions WHERE id = 'ses_shared'`,
      ]) {
        expect(
          Exit.isFailure(
            yield* Effect.exit(db.transaction((tx) => tx.run(statement))),
          ),
        ).toBe(true);
      }
      expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    }).pipe(
      Effect.provide(
        Database.layer(":memory:", (batch) =>
          Effect.sync(() => {
            changes.push(...batch);
          }),
        ),
      ),
    ),
  );
});
