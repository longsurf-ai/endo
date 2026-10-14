// Purpose: Defines the Occurrence Resource entity with scheduled-run provenance and its projected Session identity.

import { SessionId } from "@openchart/server/agent/contracts/session";
import { defineId } from "@openchart/identifier";
import {
  listKey,
  serverManaged,
} from "@openchart/server/lib/resource/annotation";
import { envelopeFields } from "@openchart/server/lib/resource/envelope";
import { createSelectSchema } from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { agentScheduleOccurrences } from "./schema";

/** Branded Occurrence Resource identifier with the `aso_` prefix. */
export const AgentScheduleOccurrenceId = defineId(
  "aso",
  "AgentScheduleOccurrence.ID",
);

/** Identifier of an Occurrence Resource. */
export type AgentScheduleOccurrenceId = typeof AgentScheduleOccurrenceId.Type;

const occurrenceColumns = createSelectSchema(agentScheduleOccurrences);

/**
 * One accepted scheduled fire, with its own identity and revision.
 * The envelope's createdAt records acceptance; fireAt is the planned instant.
 * Run owns execution status and results; a script collection has none, and
 * its Monitoring check reports the outcome instead. All fields are server-managed;
 * backend creation retains the complete body. Read/list-only API exposure
 * separately limits the available operations.
 */
export const AgentScheduleOccurrenceEntity = Schema.Struct({
  ...envelopeFields(AgentScheduleOccurrenceId),
  scheduleId: listKey(serverManaged(occurrenceColumns.fields.scheduleId)),
  agentRunId: serverManaged(occurrenceColumns.fields.agentRunId),
  // Projected from the referenced Run; never stored independently on Occurrence.
  // Both are null for a script collection, which has no Run.
  sessionId: serverManaged(Schema.NullOr(SessionId)),
  fireAt: serverManaged(occurrenceColumns.fields.fireAt),
});

/** Complete runtime shape of an Occurrence Resource. */
export type AgentScheduleOccurrenceEntity =
  typeof AgentScheduleOccurrenceEntity.Type;
