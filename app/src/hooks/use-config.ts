// Purpose: Read and save backend configuration through the shared Query definitions.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  configQueryOptions,
  refreshConfig,
  type ConfigPatch,
} from "@openchart/app/lib/config/config";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

/** Provides explicit saves without optimistic state or automatic replay. A failed save also rereads in case the response was lost after commit. @example const { config, update } = useConfig(transport); */
export function useConfig(transport: AppTransport) {
  const queryClient = useQueryClient();
  const query = useQuery(configQueryOptions(transport));
  const mutation = useMutation({
    meta: { errorTitle: "Couldn’t confirm the save" },
    mutationFn: (patch: ConfigPatch) =>
      transport.rpc.config.update.mutate(patch),
    retry: false,
    onSuccess: () => refreshConfig(queryClient),
    onError: () => refreshConfig(queryClient),
  });
  return {
    config: query.data,
    isLoading: query.isPending,
    readError: query.error,
    refresh: query.refetch,
    update: mutation.mutate,
    updateAsync: mutation.mutateAsync,
    isSaving: mutation.isPending,
    saveError: mutation.error,
    isSaved: mutation.isSuccess,
  };
}
