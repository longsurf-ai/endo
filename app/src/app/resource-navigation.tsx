// Purpose: Derive Resource destinations from route annotations outside the router.
import { useMemo, type ReactNode } from "react";
import { generatePath } from "react-router";
import {
  ResourceDestinationContext,
  type ResourceDestination,
} from "@openchart/app/lib/resource/navigation";

/** A route's canonical Resource and the path parameter that receives its ID. */
export type ResourceRouteHandle = {
  resource: { name: string; idParam: string };
};

type ResourceRoute = {
  path?: string;
  handle?: Partial<ResourceRouteHandle>;
  children?: readonly ResourceRoute[];
};

/** Derive destinations from the complete static route tree, including unvisited lazy pages.
 * Paths remain route-owned. Duplicate canonical destinations are a configuration error.
 * No resources or page modules are loaded.
 * @example const destination = resourceDestinations(router.routes);
 */
export function resourceDestinations(
  routes: readonly ResourceRoute[],
): ResourceDestination {
  const targets = new Map<string, { path: string; idParam: string }>();
  function collect(children: readonly ResourceRoute[], parentPath = "") {
    for (const route of children) {
      const path = route.path?.startsWith("/")
        ? route.path
        : [parentPath, route.path]
            .filter(Boolean)
            .join("/")
            .replace(/\/+/g, "/");
      const resource = route.handle?.resource;
      if (resource) {
        if (targets.has(resource.name))
          throw new Error(`Multiple routes for Resource ${resource.name}`);
        targets.set(resource.name, { path, idParam: resource.idParam });
      }
      if (route.children) collect(route.children, path);
    }
  }
  collect(routes);
  return (resource, id) => {
    const target = targets.get(resource);
    return target && id
      ? generatePath(target.path, { [target.idParam]: id })
      : undefined;
  };
}

/** Bind route-derived destinations to all presentation surfaces.
 * @example <ResourceNavigationProvider routes={router.routes}><RouterProvider router={router} /></ResourceNavigationProvider>
 */
export function ResourceNavigationProvider({
  routes,
  children,
}: {
  routes: readonly ResourceRoute[];
  children: ReactNode;
}) {
  const destination = useMemo(() => resourceDestinations(routes), [routes]);
  return (
    <ResourceDestinationContext.Provider value={destination}>
      {children}
    </ResourceDestinationContext.Provider>
  );
}
