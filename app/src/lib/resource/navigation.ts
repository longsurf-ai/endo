// Purpose: Let presentation ask the application for a Resource's existing page.
import { createContext } from "react";

/** Resolve a saved reference without fetching it. Unrouted resources have no destination. */
export type ResourceDestination = (
  resource: string,
  id: string,
) => string | undefined;

/** Hosts supply navigation; standalone renderers keep references readable.
 * @example <ResourceDestinationContext.Provider value={destination}>{children}</ResourceDestinationContext.Provider>
 */
export const ResourceDestinationContext = createContext<ResourceDestination>(
  () => undefined,
);
