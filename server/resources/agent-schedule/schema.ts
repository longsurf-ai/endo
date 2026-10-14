// Purpose: Owns the Schedule Resource table, its target union and recurrence schemas.

import { AgentPromptTarget } from "@openchart/server/agent/contracts/agent-prompt-target";
import {
  resourceEnvelopeColumns,
  resourceEnvelopeChecks,
} from "@openchart/server/lib/resource/envelope-columns";
import { Cron } from "croner";
import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { Schema, Struct } from "effect";

/**
 * What a fire starts: the shared Agent prompt target. Add another member to
 * this union (and a matching Scheduler dispatch case) for new target kinds.
 */
export const AgentScheduleTarget = Schema.Union([AgentPromptTarget]);
/** Complete scheduled target. */
export type AgentScheduleTarget = typeof AgentScheduleTarget.Type;

function cronFieldCount(expression: string): number {
  return expression.trim().split(/\s+/).filter(Boolean).length;
}

function usesUnsupportedCronExtension(expression: string): boolean {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return false;
  const dayOfMonth = fields[2] ?? "";
  const dayOfWeek = fields[4] ?? "";
  return (
    fields.some((field) => field.includes("?")) ||
    /[LW]/i.test(dayOfMonth) ||
    /[#L]/i.test(dayOfWeek) ||
    dayOfWeek.startsWith("+")
  );
}

/** Five-field cron recurrence with a valid time zone and future match. */
export const AgentScheduleCronRecurrence = Schema.Struct({
  kind: Schema.Literal("cron"),
  expression: Schema.Trim.check(Schema.isMinLength(1)),
  timeZone: Schema.Trim.check(Schema.isMinLength(1)),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .check(
    Schema.makeFilter((recurrence) => {
      if (cronFieldCount(recurrence.expression) !== 5) {
        return {
          path: ["expression"],
          issue: "Cron expression must contain exactly five fields",
        };
      }
      if (usesUnsupportedCronExtension(recurrence.expression)) {
        return {
          path: ["expression"],
          issue:
            "Cron expression uses an unsupported provider-specific extension",
        };
      }
      try {
        const cron = new Cron(recurrence.expression, {
          mode: "5-part",
          paused: true,
          timezone: recurrence.timeZone,
        });
        if (!cron.nextRun(new Date("2024-01-01T00:00:00.000Z"))) {
          return {
            path: ["expression"],
            issue: "Cron expression has no future matching instant",
          };
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** One-time recurrence with a canonical UTC timestamp. */
export const AgentScheduleOnceRecurrence = Schema.Struct({
  kind: Schema.Literal("once"),
  fireAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  ).check(
    Schema.makeFilter(
      (value) => {
        const parsed = new Date(value);
        return (
          Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
        );
      },
      { message: "Once fireAt must be a canonical UTC timestamp" },
    ),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** Complete durable schedule recurrence. */
export const AgentScheduleRecurrence = Schema.Union([
  AgentScheduleCronRecurrence,
  AgentScheduleOnceRecurrence,
]);

/** Parsed durable schedule recurrence value. */
export type AgentScheduleRecurrence = typeof AgentScheduleRecurrence.Type;
/** Parsed durable schedule recurrence value. */
export type AgentScheduleCronRecurrence =
  typeof AgentScheduleCronRecurrence.Type;

/** User-authored Schedule Resource and its recurrence cursor. */
export const agentSchedules = sqliteTable(
  "agent_schedule",
  {
    ...resourceEnvelopeColumns(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    target: text("target_json", { mode: "json" })
      .$type<AgentScheduleTarget>()
      .notNull(),
    recurrence: text("recurrence", { mode: "json" })
      .$type<AgentScheduleRecurrence>()
      .notNull(),
    nextFireAt: integer("next_fire_at").notNull(),
  },
  (table) => [
    ...resourceEnvelopeChecks("agent_schedule", table),
    index("idx_agent_schedules_due")
      .on(table.nextFireAt, table.id)
      .where(sql`${table.enabled} = 1`),
    index("idx_agent_schedules_updated").on(desc(table.updatedAt)),
    check(
      "chk_agent_schedules_name",
      sql`length(trim(${table.name})) BETWEEN 1 AND 160`,
    ),
    check(
      "chk_agent_schedules_target_object",
      sql`json_type(${table.target}) = 'object'`,
    ),
    check(
      "chk_agent_schedules_target",
      sql`CASE json_extract(${table.target}, '$.kind')
      WHEN 'agent_prompt' THEN COALESCE(
        json_type(${table.target}, '$.prompt.model') = 'object'
        AND json_type(${table.target}, '$.prompt.model.providerID') = 'text'
        AND length(json_extract(${table.target}, '$.prompt.model.providerID')) > 0
        AND json_extract(${table.target}, '$.prompt.model.providerID') <> 'unknown'
        AND json_type(${table.target}, '$.prompt.model.modelID') = 'text'
        AND length(json_extract(${table.target}, '$.prompt.model.modelID')) > 0
        AND json_extract(${table.target}, '$.prompt.model.modelID') <> 'unknown'
        AND (
          json_type(${table.target}, '$.prompt.model.selectedVariant') IS NULL
          OR (
            json_type(${table.target}, '$.prompt.model.selectedVariant') = 'text'
            AND length(json_extract(${table.target}, '$.prompt.model.selectedVariant')) > 0
          )
        )
        AND json(json_remove(
          json_extract(${table.target}, '$.prompt.model'),
          '$.providerID',
          '$.modelID',
          '$.selectedVariant'
        )) = '{}',
        0
      )
      ELSE 0
      END`,
    ),
    check(
      "chk_agent_schedules_recurrence_shape",
      sql`COALESCE(
        (
          json_extract(${table.recurrence}, '$.kind') = 'cron'
          AND length(
              trim(json_extract(${table.recurrence}, '$.expression'))
            ) > 0
          AND length(
              trim(json_extract(${table.recurrence}, '$.timeZone'))
            ) > 0
        ) OR (
          json_extract(${table.recurrence}, '$.kind') = 'once'
          AND json_type(${table.recurrence}, '$.fireAt') = 'text'
          AND length(
              trim(json_extract(${table.recurrence}, '$.fireAt'))
            ) > 0
        ),
        0
      )`,
    ),
  ],
);
