// Purpose: Registers the Resources shared by HTTP, Agent tools, and prompt discovery.

import { workspaceResource } from "@openchart/server/resources/workspace";
import { agentScheduleResource } from "@openchart/server/resources/agent-schedule";
import { agentScheduleOccurrenceResource } from "@openchart/server/resources/agent-schedule-occurrence";
import { Schema } from "effect";

/** The sole Resource catalog; every public surface derives from these definitions. */
export const resources = [
  workspaceResource,
  agentScheduleResource,
  agentScheduleOccurrenceResource,
] as const;

/** Public Resource names always match the registered catalog. */
export const ResourceName = Schema.Literals(
  resources.map((resource) => resource.name),
);
