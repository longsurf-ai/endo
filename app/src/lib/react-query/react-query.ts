import {
  QueryCache,
  MutationCache,
  QueryClient,
  type Query,
  type QueryClientConfig,
  type UseMutationOptions,
  type DefaultOptions,
} from "@tanstack/react-query";
import { toast } from "sonner";

declare module "@tanstack/react-query" {
  interface Register {
    /** `silent`: the consumer reports this query's errors itself, so no global toast. */
    queryMeta: { errorTitle?: string; silent?: boolean };
    /** `silent`: the consumer reports this mutation's errors itself, so no global toast. */
    mutationMeta: { errorTitle?: string; silent?: boolean };
  }
}

export const queryConfig = {
  queries: {
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 1000 * 60,
  },
} satisfies DefaultOptions;

/** Own one error notification per failing query and per mutation attempt. Polling cannot flood the toaster; successful queries clear their failure. Mutations are never automatically replayed. @example const client = createQueryClient(); */
export function createQueryClient(config: QueryClientConfig = {}) {
  const failures = new WeakMap<Query<unknown, unknown>, Error>();
  // Nested mutations/ensureQueryData propagate the same exception. Sonner's ID
  // updates that notification rather than announcing a second copy.
  const ids = new WeakMap<Error, string>();
  const errorId = (error: Error) => {
    const id = ids.get(error) ?? crypto.randomUUID();
    ids.set(error, id);
    return id;
  };
  return new QueryClient({
    defaultOptions: queryConfig,
    ...config,
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.silent) return;
        if (failures.get(query)?.message === error.message) return;
        failures.set(query, error);
        // Errors that know they cannot succeed again opt out of Retry.
        const retryable =
          !("isRetryable" in error) ||
          (error as { isRetryable?: unknown }).isRetryable !== false;
        toast.error(query.meta?.errorTitle ?? "Couldn’t load data", {
          id: errorId(error),
          description: error.message,
          action: retryable
            ? {
                label: "Retry",
                onClick: () => {
                  const previous = failures.get(query);
                  if (previous) ids.delete(previous);
                  failures.delete(query);
                  void query
                    .fetch(undefined, {
                      meta: query.state.fetchMeta ?? undefined,
                    })
                    .catch(() => {});
                },
              }
            : undefined,
        });
      },
      onSuccess: (_data, query) => {
        const previous = failures.get(query);
        failures.delete(query);
        if (previous) {
          const id = ids.get(previous);
          if (id) toast.dismiss(id);
          ids.delete(previous);
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (mutation.meta?.silent) return;
        const existing = ids.get(error);
        if (existing && toast.getToasts().some((item) => item.id === existing))
          return;
        ids.delete(error);
        toast.error(mutation.meta?.errorTitle ?? "Operation failed", {
          id: errorId(error),
          description: error.message,
        });
      },
    }),
  });
}

export type ApiFnReturnType<
  FnType extends (...args: never[]) => Promise<unknown>,
> = Awaited<ReturnType<FnType>>;

export type QueryConfig<T extends (...args: never[]) => unknown> = Omit<
  ReturnType<T>,
  "queryKey" | "queryFn"
>;

export type MutationConfig<
  MutationFnType extends (...args: never[]) => Promise<unknown>,
> = UseMutationOptions<
  ApiFnReturnType<MutationFnType>,
  Error,
  Parameters<MutationFnType>[0]
>;
