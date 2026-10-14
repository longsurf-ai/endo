// Purpose: Carries native AG-UI events inside the shared application envelope.

import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";
import { EventDefinition } from "@openchart/server/events";
import { Schema } from "effect";
import type { Publisher } from "@openchart/server/agent/publisher/publisher";
import {
  SessionListItem,
  SessionState,
  projectRuns,
} from "@openchart/server/agent/session/state";

// AG-UI owns its protocol schema. This declaration only bridges that boundary
// into the application's Effect event-definition system.
const NativeEvent = Schema.declare(
  (value): value is AGUIEvent => EventSchemas.safeParse(value).success,
);

/** Native protocol payload; application correlation stays on the outer envelope. */
export const AgentEvent = EventDefinition.define({
  type: "agent.event",
  schema: { sessionID: Schema.String, event: NativeEvent },
});

/** Initializes waiting observers of one Session at an ordered point on the bus. */
export const AgentSnapshot = EventDefinition.define({
  type: "agent.snapshot",
  schema: {
    sessionID: Schema.String,
    events: Schema.Array(NativeEvent),
  },
});

/** Initializes the session directory without observing individual transcripts. */
export const SessionListBootstrap = EventDefinition.define({
  type: "agent.sessions.bootstrap",
  schema: {
    items: Schema.Array(SessionListItem),
    nextCursor: Schema.NullOr(Schema.String),
  },
});

/**
 * Encodes replacement of one public Session state field as a native delta.
 * @example
 * const event = stateEvent('permissions', pending);
 */
export function stateEvent<K extends keyof typeof SessionState.Type>(
  field: K,
  value: (typeof SessionState.Type)[K],
): AGUIEvent {
  return {
    type: EventType.STATE_DELTA,
    delta: [{ op: "add", path: `/${field}`, value }],
  };
}

/**
 * Encodes one durable Run change, preserving native lifecycle/state ordering.
 * Enqueue includes idempotent admission and never opens or closes a native Run.
 * @example
 * const events = runEvents(change);
 */
export function runEvents(
  change: Extract<Publisher.Change, { type: "run.updated" }>,
): AGUIEvent[] {
  const { run } = change;
  const events: AGUIEvent[] = [];
  if (change.operation !== "enqueue" && run.status === "running")
    events.push({
      type: EventType.RUN_STARTED,
      threadId: run.sessionID,
      runId: run.id,
    });
  events.push(stateEvent("runs", projectRuns(change.runs)));
  if (
    change.operation !== "enqueue" &&
    (run.status === "completed" || run.status === "stop")
  )
    events.push({
      type: EventType.RUN_FINISHED,
      threadId: run.sessionID,
      runId: run.id,
    });
  if (change.operation !== "enqueue" && run.status === "failed")
    events.push({
      type: EventType.RUN_ERROR,
      message: "Run failed or was interrupted; see the transcript.",
      code: "RUN_FAILED",
    });
  return events;
}
