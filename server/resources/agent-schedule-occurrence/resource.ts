// Purpose: Composes Occurrence reads and idempotent backend acceptance through Resource transitions.

import { defineResource } from "@openchart/server/lib/resource/definition";
import { ensureOccurrence } from "@openchart/server/resources/agent-schedule-occurrence/transitions/ensure-occurrence";

import { AgentScheduleOccurrenceEntity } from "./entity";
import { agentScheduleOccurrenceStore } from "./store";

export {
  AgentScheduleOccurrenceEntity,
  AgentScheduleOccurrenceId,
} from "./entity";

/** Backend-authored scheduled fires with a projected Session reference. */
export const agentScheduleOccurrenceResource = defineResource({
  name: "agent_schedule_occurrence",
  description:
    "A record that a scheduled Agent prompt was accepted, linking the Schedule and fire time to its Run and Session. Execution status and results belong to that Run and Session.",
  readOnly: true,
  entity: AgentScheduleOccurrenceEntity,
  store: agentScheduleOccurrenceStore,
  transitions: { ensureOccurrence },
});

/** Complete Occurrence returned by Resource reads. */
export type AgentScheduleOccurrence =
  typeof agentScheduleOccurrenceResource.entity.Type;
