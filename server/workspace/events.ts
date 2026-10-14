// Purpose: Invalidate file queries when directory state or committed files change.
import { EventDefinition } from "@openchart/server/events";
/** Payload-free signal; clients reread the authoritative directory state. */
export const WorkspaceChanged = EventDefinition.define({
  type: "workspace.changed",
  schema: {},
});
