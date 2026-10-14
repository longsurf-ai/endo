// Purpose: Owns scheduled occurrence provenance and its Schedule and Run foreign keys.

import { agentRun } from "@openchart/server/agent/schema";
import {
  resourceEnvelopeChecks,
  resourceEnvelopeColumns,
} from "@openchart/server/lib/resource/envelope-columns";
import { agentSchedules } from "@openchart/server/resources/agent-schedule/schema";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** One accepted fire per scheduled instant, addressed as its own Resource. */
export const agentScheduleOccurrences = sqliteTable(
  "agent_schedule_occurrence",
  {
    // @agent invariant: Creation accepts the fire; createdAt is its acceptance time.
    ...resourceEnvelopeColumns(),
    // Deleting a Schedule removes its occurrences; referenced Runs and Sessions survive.
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => agentSchedules.id, { onDelete: "cascade" }),
    // Null for a script collection, which runs without an Agent Run.
    agentRunId: text("agent_run_id").references(() => agentRun.id, {
      onDelete: "restrict",
    }),
    fireAt: integer("fire_at").notNull(),
  },
  (table) => [
    ...resourceEnvelopeChecks("agent_schedule_occurrence", table),
    // @agent invariant: Each fire slot accepts one run; a run cannot serve two occurrences.
    uniqueIndex("uq_agent_schedule_occurrences_slot").on(
      table.scheduleId,
      table.fireAt,
    ),
    uniqueIndex("uq_agent_schedule_occurrences_run").on(table.agentRunId),
  ],
);
