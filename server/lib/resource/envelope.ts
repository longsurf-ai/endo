// Purpose: Declares the resource envelope fields once; Resource transitions assign identity/revision and SQLite supplies timestamps.

import type { IdSchema } from "@openchart/identifier";
import { Schema } from "effect";

import { serverManaged } from "./annotation";

/** Optimistic-concurrency version. A new entity starts at 1 and only grows. */
export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Optimistic-concurrency version carried by every entity read and every patch. */
export type Revision = typeof Revision.Type;

/** Unix epoch time in milliseconds, matching the agent_run timestamp columns. */
export const Timestamp = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Builds the four envelope fields for one resource identifier schema.
 *
 * Every field is server-managed: reads return them, no client write surface accepts
 * them. Resource transitions assign id/revision; SQLite supplies timestamps.
 *
 * @param id - The resource's identifier schema.
 * @returns Struct fields to spread ahead of the domain fields.
 *
 * @example
 * ```ts
 * const Entity = Schema.Struct({...envelopeFields(AgentScheduleId), name: Schema.String});
 * ```
 */
export function envelopeFields<Id extends IdSchema>(id: Id) {
  return {
    // Annotation rebuilds the schema; preserve its resource-owned constructor.
    id: Object.assign(serverManaged(id), { create: id.create as Id["create"] }),
    revision: serverManaged(Revision),
    createdAt: serverManaged(Timestamp),
    updatedAt: serverManaged(Timestamp),
  };
}

/** The envelope fields as a type, parameterized by the identifier schema. */
export type EnvelopeFields<Id extends IdSchema> = ReturnType<
  typeof envelopeFields<Id>
>;

/** Names of the envelope fields; a domain field may not reuse one. */
export const ENVELOPE_FIELD_NAMES = [
  "id",
  "revision",
  "createdAt",
  "updatedAt",
] as const;
