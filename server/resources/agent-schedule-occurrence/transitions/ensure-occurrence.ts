// Purpose: Records scheduled fires idempotently while preserving their accepted Run and Session.

import { Transition } from "@openchart/server/lib/resource";
import { toEntity } from "@openchart/server/lib/resource/entity-operations";
import { ENVELOPE_FIELD_NAMES } from "@openchart/server/lib/resource/envelope";
import {
  listPage,
  MAX_PAGE_SIZE,
  type ListPosition,
} from "@openchart/server/lib/resource/pagination";
import { AgentScheduleOccurrenceEntity } from "@openchart/server/resources/agent-schedule-occurrence/entity";
import { agentScheduleOccurrenceStore } from "@openchart/server/resources/agent-schedule-occurrence/store";
import { assertTrue } from "@openchart/utils/assert";
import { Effect, Schema, Struct } from "effect";

/**
 * Records a scheduled fire through its Store in the caller's transaction.
 * A replay must reference the same Run and its projected Session. This transaction
 * contains only occurrence bookkeeping; prompt admission has already committed.
 * @example
 * defineResource({name, entity, store, transitions: {ensureOccurrence}});
 */
export const ensureOccurrence = Transition.make({
  input: Schema.Struct(
    Struct.omit(AgentScheduleOccurrenceEntity.fields, ENVELOPE_FIELD_NAMES),
  ),
  resolve: () => Effect.void,
  apply: (tx, body) =>
    Effect.gen(function* () {
      let cursor: ListPosition | undefined;
      do {
        const rows = yield* agentScheduleOccurrenceStore.list(
          tx,
          { scheduleId: body.scheduleId },
          { limit: MAX_PAGE_SIZE + 1, cursor },
        );
        const page = listPage(rows, MAX_PAGE_SIZE);
        const occurrences = yield* Effect.forEach(page.items, (row) =>
          toEntity(
            "agent_schedule_occurrence",
            AgentScheduleOccurrenceEntity,
            row,
          ),
        );
        const occurrence = occurrences.find(
          (item) => item.fireAt === body.fireAt,
        );
        if (occurrence) {
          // A replay must retain the Run and projected Session accepted for this fire.
          assertTrue(
            occurrence.agentRunId === body.agentRunId &&
              occurrence.sessionId === body.sessionId,
            "A scheduled fire must retain its accepted Run and Session",
          );
          return occurrence;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const row = yield* agentScheduleOccurrenceStore.insert(tx, {
        id: AgentScheduleOccurrenceEntity.fields.id.create(),
        revision: 1,
        body,
      });
      return yield* toEntity(
        "agent_schedule_occurrence",
        AgentScheduleOccurrenceEntity,
        row,
      );
    }),
});
