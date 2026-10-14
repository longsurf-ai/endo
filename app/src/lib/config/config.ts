// Purpose: Mirror backend configuration with Query and refresh it over the shared event connection.

import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { filter } from "rxjs";

import type { AppTransport } from "@openchart/app/lib/transport/transport";

/** Public settings contain preferences and provider configuration, never secrets. */
export type AppConfig = Awaited<
  ReturnType<AppTransport["rpc"]["config"]["get"]["query"]>
>;
/** Server-validated JSON merge patch; null restores a field's default. */
export type ConfigPatch = Parameters<
  AppTransport["rpc"]["config"]["update"]["mutate"]
>[0];
/** One config cache per mounted backend; composition clears it when replacing the backend. */
export const configQueryKey = [["config"]] as const;

/** Reads the file-backed settings and cancels obsolete requests. @example useQuery(configQueryOptions(transport)); */
export function configQueryOptions(transport: AppTransport) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t read settings" },
    queryKey: configQueryKey,
    queryFn: ({ signal }) =>
      transport.rpc.config.get.query(undefined, { signal }),
    retry: false,
  });
}

/** Cancels initial reads too; refetch errors remain on the query, separately from saved mutations. @example await refreshConfig(queryClient); */
export async function refreshConfig(queryClient: QueryClient) {
  await queryClient.cancelQueries({ queryKey: configQueryKey });
  await queryClient.invalidateQueries({ queryKey: configQueryKey });
}

/** Observes the existing SSE connection; initial readiness and reconnect both reread config. Unsubscribe releases only this observer. @example const subscription = subscribeConfigInvalidation(transport, queryClient); */
export function subscribeConfigInvalidation(
  transport: AppTransport,
  queryClient: QueryClient,
  onError: (error: unknown) => void = console.error,
) {
  return transport.events
    .pipe(
      filter(
        (frame) =>
          frame.kind === "ready" ||
          (frame.kind === "event" && frame.event.type === "config.changed"),
      ),
    )
    .subscribe({
      next: () => {
        void refreshConfig(queryClient).catch(onError);
      },
      error: onError,
    });
}
