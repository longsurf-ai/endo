// Purpose: Invalidates model discovery after the active registry configuration changes.

import { EventDefinition } from "@openchart/server/events";

const Changed = EventDefinition.define({ type: "models.changed", schema: {} });

/** Registry replacement notifications; payloads contain no provider credentials. */
export const Event = {
  Changed,
  Definitions: EventDefinition.inventory(Changed),
};
