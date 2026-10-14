// Purpose: Derives the Schedule Resource entity from its table and canonical prompt and recurrence schemas.

import { defineId } from "@openchart/identifier";
import { serverManaged } from "@openchart/server/lib/resource/annotation";
import { envelopeFields } from "@openchart/server/lib/resource/envelope";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Effect, Schema } from "effect";

import {
  AgentScheduleRecurrence,
  AgentScheduleTarget,
  agentSchedules,
} from "./schema";

/** Branded Schedule Resource identifier with the `ags_` prefix. */
export const AgentScheduleId = defineId("ags", "AgentSchedule.ID");

/** Identifier of a Schedule Resource. */
export type AgentScheduleId = typeof AgentScheduleId.Type;

const scheduleColumns = createSelectSchema(agentSchedules, {
  name: (schema) =>
    schema.check(
      Schema.makeFilter(
        (name) => {
          const length = name.trim().length;
          return length >= 1 && length <= 160;
        },
        {
          message:
            "Schedule name must contain 1 to 160 characters after trimming",
        },
      ),
    ),
  target: AgentScheduleTarget,
  recurrence: AgentScheduleRecurrence,
});

/**
 * Complete Schedule definition with its independent Resource envelope.
 * Name, enabled state, target, and recurrence are authored values. The execution
 * cursor is maintained by backend operations.
 * Occurrence history is addressed separately and never embedded in this entity.
 */
export const AgentScheduleEntity = Schema.Struct({
  ...envelopeFields(AgentScheduleId),
  name: scheduleColumns.fields.name,
  enabled: scheduleColumns.fields.enabled.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(
        Schema.decodeUnknownSync(scheduleColumns.fields.enabled)(
          agentSchedules.enabled.default,
        ),
      ),
    ),
  ),
  target: scheduleColumns.fields.target,
  recurrence: scheduleColumns.fields.recurrence,
  nextFireAt: serverManaged(scheduleColumns.fields.nextFireAt),
});

/** Complete runtime shape of a Schedule Resource. */
export type AgentScheduleEntity = typeof AgentScheduleEntity.Type;
