// Purpose: Advances the Schedule cursor while preserving concurrent edits, pauses, and deletion.

import { Transition } from "@openchart/server/lib/resource";
import { toEntity } from "@openchart/server/lib/resource/entity-operations";
import { ENVELOPE_FIELD_NAMES } from "@openchart/server/lib/resource/envelope";
import { AgentScheduleEntity } from "@openchart/server/resources/agent-schedule/entity";
import { nextScheduleFire } from "@openchart/server/resources/agent-schedule/recurrence";
import { agentScheduleStore } from "@openchart/server/resources/agent-schedule/store";
import { Effect, Struct } from "effect";

/**
 * Advances a recurring definition only if its selected revision and cursor still match.
 * The resolver skips missed intervals; the apply phase preserves concurrent edits,
 * pauses, and deletion. Occurrence acceptance exhausts one-time definitions.
 * @example
 * yield* Transactor.run(Transition.bindInput(advanceSchedule, selected));
 */
export const advanceSchedule = Transition.make({
  input: AgentScheduleEntity,
  resolve: (selected) =>
    selected.recurrence.kind === "once"
      ? Effect.succeed(undefined)
      : nextScheduleFire(selected.recurrence),
  apply: (tx, selected, nextFireAt) =>
    Effect.gen(function* () {
      if (nextFireAt === undefined) return false;
      const row = yield* agentScheduleStore.load(tx, selected.id);
      if (!row || row.revision !== selected.revision) return false;
      const current = yield* toEntity(
        "agent_schedule",
        AgentScheduleEntity,
        row,
      );
      if (!current.enabled || current.nextFireAt !== selected.nextFireAt)
        return false;
      const saved = yield* agentScheduleStore.save(tx, current.id, {
        revision: current.revision + 1,
        body: { ...Struct.omit(current, ENVELOPE_FIELD_NAMES), nextFireAt },
      });
      yield* toEntity("agent_schedule", AgentScheduleEntity, saved);
      return true;
    }),
});
