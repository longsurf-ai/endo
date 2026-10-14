// Purpose: Derive one Workspace SSE subscription from React Query's active readers.
import type { Query, QueryClient, QueryFilters } from "@tanstack/react-query";
import {
  Observable,
  EMPTY,
  asapScheduler,
  auditTime,
  distinctUntilChanged,
  from,
  map,
  mergeMap,
  startWith,
  switchMap,
} from "rxjs";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

type Interest = Parameters<
  AppTransport["rpc"]["workspace"]["watch"]["subscribe"]
>[0]["interests"][number];

/** A read's own file or directory; a program read's reached files, or its entry before the first read. */
function interestsOf({ queryKey, state }: Query): Interest[] {
  const [, , workspaceId, kind, path] = queryKey;
  if (typeof workspaceId !== "string" || typeof path !== "string") return [];
  if (kind === "file" || kind === "directory")
    return [{ workspaceId, target: { kind, path } }];
  if (kind !== "program") return [];
  const read = state.data as { sources: Record<string, unknown> } | undefined;
  return (read ? Object.keys(read.sources) : [path]).map((file) => ({
    workspaceId,
    target: { kind: "file", path: file },
  }));
}

const same = (left: Interest, right: Interest) =>
  left.workspaceId === right.workspaceId &&
  left.target.kind === right.target.kind &&
  left.target.path === right.target.path;

/**
 * Query already owns sharing and consumer lifetimes. Observe its active file,
 * directory and program keys; cached and disabled queries need no filesystem
 * resources. RxJS switches and releases subscriptions; tRPC reconnects, and
 * initial notifications close read/subscribe races. Unsubscribe releases all work.
 * @example const subscription = observeWorkspaceQueries(transport, client, reportError);
 */
export function observeWorkspaceQueries(
  transport: AppTransport,
  client: QueryClient,
  onError: (error: unknown) => void,
) {
  const cache = client.getQueryCache();
  function activeInterests() {
    const interests = new Map<string, Interest>();
    for (const query of cache.findAll({
      queryKey: [["workspace"], transport.url],
      type: "active",
    }))
      for (const interest of interestsOf(query))
        interests.set(JSON.stringify(interest), interest);
    return [...interests.values()];
  }
  function observeInterests(interests: Interest[]) {
    if (interests.length === 0) return EMPTY;
    return new Observable<Interest>((subscriber) => {
      const connection = transport.rpc.workspace.watch.subscribe(
        { interests },
        {
          onData: (interest) => subscriber.next(interest),
          // Report transport errors without ending Query observation or tRPC recovery.
          onError: (error) => {
            if (!subscriber.closed) onError(error);
          },
        },
      );
      return () => connection.unsubscribe();
    });
  }
  const changes = new Observable<void>((subscriber) =>
    cache.subscribe((event) => {
      if (
        event.type === "observerAdded" ||
        event.type === "observerRemoved" ||
        event.type === "observerOptionsUpdated" ||
        event.type === "removed" ||
        // A program read's files change with its imports.
        (event.type === "updated" &&
          event.action.type === "success" &&
          event.query.queryKey[3] === "program")
      )
        subscriber.next();
    }),
  );
  return changes
    .pipe(
      startWith(undefined),
      auditTime(0, asapScheduler),
      map(activeInterests),
      distinctUntilChanged((left, right) => left === right, JSON.stringify),
      switchMap((interests) =>
        observeInterests(interests).pipe(
          mergeMap((notified) => {
            const filters = {
              queryKey: [["workspace"], transport.url, notified.workspaceId],
              predicate: (query) =>
                interestsOf(query).some((interest) => same(interest, notified)),
            } satisfies QueryFilters;
            // Invalidation alone reuses an unfinished first fetch (no cached data).
            // Cancel it explicitly so pre-change bytes cannot become the fresh result.
            return from(
              client.cancelQueries({
                ...filters,
                predicate: (query) =>
                  query.state.data === undefined && filters.predicate(query),
              }),
            ).pipe(mergeMap(() => client.invalidateQueries(filters)));
          }),
        ),
      ),
    )
    .subscribe({ error: onError });
}
