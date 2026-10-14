// Purpose: Owns finite Agent queries and refreshes query caches from committed app events.

import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { filter, map, merge, mergeMap } from "rxjs";

import type { NativeProviderID } from "@openchart/models/model-tiers";
import type { AgentClient } from "@openchart/app/lib/agent/client";
import type {
  AgentInputs,
  AppTransport,
} from "@openchart/app/lib/transport/transport";

/** Reads a binding without creating anything; directory changes refresh it.
 * @example useQuery(boundSessionQueryOptions(transport, key));
 */
export function boundSessionQueryOptions(transport: AppTransport, key: string) {
  return queryOptions({
    queryKey: [...agentQueryKeys.sessions(transport.url), "binding", key],
    queryFn: ({ signal }) =>
      transport.rpc.agent.getSessionByBinding.query({ key }, { signal }),
  });
}

/** Shared keys keep directory/model caches scoped to their endpoint. */
export const agentQueryKeys = {
  all: ["agent"] as const,
  sessions: (url: string) => ["agent", "sessions", url] as const,
  modelProviders: (url: string) => ["agent", "models", url] as const,
  providerSetup: (url: string, providerID?: NativeProviderID) =>
    providerID
      ? (["agent", "provider-setup", url, providerID] as const)
      : (["agent", "provider-setup", url] as const),
  commands: (url: string) => ["agent", "commands", url] as const,
  transcript: (url: string, sessionID: string) =>
    ["agent", "transcript", url, sessionID] as const,
};

/**
 * Reads older complete turns after the live snapshot's boundary. The shared
 * Session observer requests pages explicitly and replaces this query on snapshots.
 * @example const options = transcriptQueryOptions(remote, sessionID, nextCursor);
 */
export function transcriptQueryOptions(
  remote: Pick<AgentClient, "readTranscriptPage"> & {
    transport: { url: string };
  },
  sessionID: string,
  cursor: string | undefined,
) {
  return infiniteQueryOptions({
    meta: { errorTitle: "Couldn’t load earlier messages" },
    queryKey: agentQueryKeys.transcript(remote.transport.url, sessionID),
    initialPageParam: cursor,
    queryFn: ({ pageParam, signal }) =>
      remote.readTranscriptPage({ sessionID, cursor: pageParam }, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: false,
    staleTime: Infinity,
    gcTime: 0,
  });
}

/** Read root chat Sessions in server order, fifteen at a time. Query owns pages and cancellation. @example useInfiniteQuery(sessionsQueryOptions(remote)); */
export function sessionsQueryOptions(
  remote: AgentClient,
  orderBy: NonNullable<AgentInputs["listSessions"]["orderBy"]> = "updatedAt",
) {
  return infiniteQueryOptions({
    meta: { errorTitle: "Couldn’t load chats" },
    queryKey: [
      ...agentQueryKeys.sessions(remote.transport.url),
      "directory",
      orderBy,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      remote.listSessions(
        { limit: 15, cursor: pageParam, orderBy },
        { signal },
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

/** Available providers and their models come directly from the existing model registry. @example queryClient.fetchQuery(modelProvidersQueryOptions(remote)); */
export function modelProvidersQueryOptions(remote: AgentClient) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load models" },
    queryKey: agentQueryKeys.modelProviders(remote.transport.url),
    queryFn: ({ signal }) => remote.models({ signal }),
  });
}

/** Shares setup progress across Settings and composer controls. @example useQuery(providerSetupQueryOptions(transport, CODEX)); */
export function providerSetupQueryOptions(
  transport: AppTransport,
  providerID: NativeProviderID,
) {
  return queryOptions({
    queryKey: agentQueryKeys.providerSetup(transport.url, providerID),
    queryFn: ({ signal }) =>
      transport.rpc.models.setupState.query({ providerID }, { signal }),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1000 : false,
  });
}

/** Reads serializable slash-command definitions from the backend catalog. @example useQuery(commandsQueryOptions(remote)); */
export function commandsQueryOptions(remote: AgentClient) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load commands" },
    queryKey: agentQueryKeys.commands(remote.transport.url),
    queryFn: ({ signal }) => remote.commands({ signal }),
  });
}

/** Lists root chats by the selected timestamp, newest first. @example const sessions = useSessions(remote); */
export function useSessions(
  remote: AgentClient,
  orderBy?: AgentInputs["listSessions"]["orderBy"],
) {
  return useInfiniteQuery(sessionsQueryOptions(remote, orderBy));
}

/** Reads available providers and their models; an empty list is distinct from a failed query. @example const modelProviders = useModelProviders(remote); */
export function useModelProviders(remote: AgentClient) {
  return useQuery(modelProvidersQueryOptions(remote));
}

/** Creates a real Session before refreshing its directory. @example const create = useCreateSession(remote); await create.mutateAsync({}); */
export function useCreateSession(remote: AgentClient) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t create a chat" },
    mutationFn: remote.createSession,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: agentQueryKeys.sessions(remote.transport.url),
      }),
  });
}

/** Archives a Session and refreshes the directory after success; failures keep the chat visible. @example const archive = useArchiveSession(remote); archive.mutate({ sessionID }); */
export function useArchiveSession(remote: AgentClient) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t archive this chat" },
    mutationFn: remote.archiveSession,
    retry: false,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: agentQueryKeys.sessions(remote.transport.url),
      }),
  });
}

/** Copies a reply's history, refreshes the directory after commit, and notifies on failure. @example const fork = useForkSession(remote); await fork.mutateAsync({ sessionID, messageID }); */
export function useForkSession(remote: AgentClient) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t branch this chat" },
    mutationFn: remote.forkSession,
    retry: false,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: agentQueryKeys.sessions(remote.transport.url),
      }),
  });
}

/**
 * Subscribes once at the app root. Ready/reconnect refreshes Agent queries;
 * committed Session metadata and Run changes refresh the session directory.
 * Unsubscribe releases this observer's share of the app SSE connection.
 * @example const subscription = subscribeQueryInvalidation(remote, queryClient, reportError);
 */
export function subscribeQueryInvalidation(
  remote: AgentClient,
  queryClient: QueryClient,
  onError: (error: unknown) => void = console.error,
) {
  return merge(
    remote.directoryChanges.pipe(
      map(() => agentQueryKeys.sessions(remote.transport.url)),
    ),
    remote.events.pipe(
      filter((frame) => frame.kind === "ready"),
      map(() => agentQueryKeys.all),
    ),
    remote.events.pipe(
      filter(
        (frame) =>
          frame.kind === "event" && frame.event.type === "models.changed",
      ),
      mergeMap(() => [
        agentQueryKeys.modelProviders(remote.transport.url),
        agentQueryKeys.providerSetup(remote.transport.url),
      ]),
    ),
  ).subscribe({
    next: (queryKey) => {
      // Explicit cancellation also restarts an initial query without cached data.
      void queryClient
        .cancelQueries({ queryKey })
        .then(() => queryClient.invalidateQueries({ queryKey }))
        .catch(onError);
    },
    error: onError,
  });
}
