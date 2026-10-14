// Purpose: Share backend transport with child routes.
import type { AppTransport } from "@openchart/app/lib/transport/transport";

/** Layout supplies transport; AgentProvider shares Agent capabilities. */
export type AppRouteContext = {
  transport: AppTransport;
};
