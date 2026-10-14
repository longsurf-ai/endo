// Purpose: Aggregate Resource procedures and existing cross-Resource APIs under resources.

import { trpc } from "@openchart/server/lib/trpc";
import { resourceRouters } from "@openchart/server/lib/trpc/resource-router";
import { resources } from "./catalog";
import { macroRouter } from "./macro-router";

/**
 * Aggregates Resource procedures by name. The server mounts this router at
 * `resources`, exposing `trpc.resources.<resource>.<action>` and
 * `trpc.resources.macro.<action>`. Resource queries derive from their declared
 * transitions; cross-Resource operations retain their existing handlers.
 */
export const resourceRouter = trpc.router({
  ...resourceRouters(resources),
  macro: macroRouter,
});
