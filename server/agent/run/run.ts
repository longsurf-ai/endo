// Purpose: Defines and parses the durable agent-run application shape.

import { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import * as Identifier from "@openchart/identifier";
import { Schema, Struct } from "effect";

import { AgentRunStatus, agentRun } from "@openchart/server/agent/schema";

const AgentRunID = Schema.String.check(Schema.isStartsWith("agr_")).pipe(
  Schema.brand("AgentRun.ID"),
);

/** A durable agent-run identifier with the `agr_` prefix. */
export type ID = typeof AgentRunID.Type;

/**
 * Schema and constructor for durable agent-run identifiers.
 *
 * @example
 * ```ts
 * const id = AgentRun.ID.create();
 * ```
 */
export const ID = Object.assign(AgentRunID, {
  create: (): ID =>
    Schema.decodeUnknownSync(AgentRunID)(`agr_${Identifier.ascending()}`),
});

/** One accepted prompt and its durable queue/execution lifecycle. */
export const AgentRun = Schema.Struct({
  id: ID,
  sessionID: Schema.String.check(Schema.isMinLength(1)),
  sessionIntentID: Schema.String.check(Schema.isMinLength(1)),
  input: AgentPromptInput,
  status: AgentRunStatus,
  queuePosition: Schema.NullOr(
    Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  createdAt: Schema.Finite.check(Schema.isInt()).check(
    Schema.isGreaterThanOrEqualTo(0),
  ),
  startedAt: Schema.NullOr(
    Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  finishedAt: Schema.NullOr(
    Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  ),
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** One accepted prompt and its durable queue/execution lifecycle. */
export type AgentRun = typeof AgentRun.Type;

/** Row selected from the canonical {@link agentRun} table. */
export type Row = typeof agentRun.$inferSelect;

/**
 * Parses a database row into the public durable run shape.
 *
 * @param row - Row read from {@link agentRun}.
 * @returns The parsed run with its prompt input checked at the DB boundary.
 *
 * @example
 * ```ts
 * const run = fromRow(row);
 * ```
 */
export function fromRow(row: Row): AgentRun {
  return Schema.decodeUnknownSync(AgentRun)({
    id: row.id,
    sessionID: row.sessionId,
    sessionIntentID: row.sessionIntentId,
    input: row.input,
    status: row.status,
    queuePosition: row.queuePosition,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}
