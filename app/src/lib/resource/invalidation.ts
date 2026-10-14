// Purpose: Refreshes Resource query prefixes from the shared application event connection.

import type { QueryClient } from "@tanstack/react-query";
import { auditTime, filter, groupBy, map, mergeMap } from "rxjs";
import { z } from "zod";

import type { AppTransport } from "@openchart/app/lib/transport/transport";

/** Resource keys follow the existing nested tRPC path convention. */
export const resourceQueryKeys = {
  all: [["resources"]] as const,
  resource: (name: string) => [["resources", name]] as const,
};

/** Minimal shared invalidation envelope; each owner re-reads its canonical state. */
export const ResourceChanged = z.object({ resource: z.string() });

/**
 * Coalesces committed changes per Resource over 100ms, including repeated
 * revisions. Ready/reconnect immediately refreshes all Resource queries after gaps.
 * Unsubscribe releases this observer's share of the app SSE connection.
 * @example const subscription = subscribeResourceInvalidation(transport, queryClient, reportError);
 */
export function subscribeResourceInvalidation(
  transport: Pick<AppTransport, "events">,
  queryClient: QueryClient,
  onError: (error: unknown) => void = console.error,
) {
  return transport.events
    .pipe(
      map((frame) => {
        if (frame.kind === "ready") return resourceQueryKeys.all;
        if (frame.kind === "event" && frame.event.type === "resource.changed")
          return resourceQueryKeys.resource(
            ResourceChanged.parse(frame.event.data).resource,
          );
        return undefined;
      }),
      filter((queryKey) => queryKey !== undefined),

      groupBy((queryKey) => queryKey[0][1]),
      mergeMap((group) =>
        group.key === undefined ? group : group.pipe(auditTime(100)),
      ),
    )
    .subscribe({
      next: (queryKey) => {
        // Restart initial reads too, so a change cannot be lost while they resolve.
        void queryClient
          .cancelQueries({ queryKey })
          .then(() => queryClient.invalidateQueries({ queryKey }))
          .catch(onError);
      },
      error: onError,
    });
}
