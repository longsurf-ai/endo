// Purpose: Notify config readers after source changes, including invalid-file transitions.
import { EventDefinition } from "@openchart/server/events";

/** Config readers must refetch; the event never carries configuration values. */
export const ConfigChanged = EventDefinition.define({
  type: "config.changed",
  schema: {},
});
