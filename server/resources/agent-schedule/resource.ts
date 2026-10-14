// Purpose: Composes Schedule CRUD and guarded backend cursor advancement.

import { defineResource } from "@openchart/server/lib/resource/definition";

import { AgentScheduleEntity } from "./entity";
import { agentScheduleStore } from "./store";

export { AgentScheduleEntity, AgentScheduleId } from "./entity";
export { advanceSchedule } from "@openchart/server/resources/agent-schedule/transitions/advance-schedule";

/** User-authored schedules; persistence does not start schedule execution. */
export const agentScheduleResource = defineResource({
  name: "agent_schedule",
  description:
    "A saved schedule for an Agent prompt, with enabled state and either a one-time fire or a cron recurrence with a time zone. The server maintains nextFireAt; accepted fires are recorded as agent_schedule_occurrence Resources.",
  entity: AgentScheduleEntity,
  store: agentScheduleStore,
});

/** Complete Schedule returned by Resource reads and writes. */
export type AgentSchedule = typeof agentScheduleResource.entity.Type;
