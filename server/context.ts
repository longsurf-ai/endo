// Purpose: Own the application context injected into tRPC handlers.

import type { Runtime } from "./runtime";

/** Server-instance dependencies shared by transport handlers. */
export interface Context {
  /** Server-lifetime Effect runtime; route definitions never capture an instance. */
  readonly runtime: Runtime;
}
