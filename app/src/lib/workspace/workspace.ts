// Purpose: Reads Workspace files with Query and refreshes them through the shared SSE connection.

import {
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { filter } from "rxjs";
import { z } from "zod/v3";
import { createContext, type ReactNode } from "react";
import { create } from "zustand";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import type { AppHost } from "@openchart/app/lib/host/host";
import { observeWorkspaceQueries } from "./workspace-observation";

type FileRpc = AppTransport["rpc"]["workspace"];

/** App composition supplies file navigation; features never own route paths. */
export const WorkspaceFileNavigation = createContext<
  ((file: { workspaceId: string; path: string }) => void) | null
>(null);

/**
 * App composition contributes extra tab-header actions for a file; the Workspace
 * renders the returned node beside its own actions and never knows what they do.
 * `prepare()` saves the active tab first when it holds unsaved edits and resolves
 * immediately otherwise; it rejects when that save fails (already reported), so the
 * action should stop. Without a provider the Workspace shows only its own actions.
 * @example <WorkspaceFileActions.Provider value={(file, prepare) => <AddToChart file={file} prepare={prepare} />}>
 */
export const WorkspaceFileActions = createContext<
  | ((
      file: { workspaceId: string; path: string },
      prepare: () => Promise<void>,
    ) => ReactNode)
  | null
>(null);

/**
 * App composition submits a file merge prompt and reveals its conversation.
 * Resolves only after admission; rejection leaves the caller's draft intact.
 * @example <WorkspaceFileMerge.Provider value={submitMerge}>{children}</WorkspaceFileMerge.Provider>
 */
export const WorkspaceFileMerge = createContext<
  ((workspaceId: string, prompt: string) => Promise<void>) | null
>(null);

/** One pending file per Workspace placement; its widget clears the entry once opened, so the latest request wins and a remount never repeats it. */
export const useWorkspaceFileRequests = create<
  Partial<Record<string, { workspaceId: string; path: string }>>
>(() => ({}));

/** Ask a Workspace placement to open a file now, or once it mounts. @example requestWorkspaceFile(placementId, { workspaceId, path }); */
export function requestWorkspaceFile(
  placementId: string,
  file: { workspaceId: string; path: string },
) {
  useWorkspaceFileRequests.setState({ [placementId]: file });
}

/** Workspace file keys are distinct from the persisted Resource registry. */
export const workspaceQueryKeys = {
  all: [["workspace"]] as const,
  workspace: (url: string, id: string) => [["workspace"], url, id] as const,
  /** A read of `entry` and every file it reaches, as `{sources}` keyed by path; while active, a change to any of them re-reads it. */
  program: (url: string, id: string, entry: string) =>
    [["workspace"], url, id, "program", entry] as const,
};

/** Reads the backend's stable default Workspace ID. @example useQuery(defaultWorkspaceQueryOptions(transport)); */
export function defaultWorkspaceQueryOptions(transport: AppTransport) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load the default workspace" },
    queryKey: [
      ["resources", "workspace", "getDefault"],
      transport.url,
    ] as const,
    queryFn: ({ signal }) =>
      transport.rpc.resources.workspace.getDefault.query(undefined, { signal }),
    retry: false,
  });
}

/** A registration's display name: its folder's name, or the whole root for a drive. @example workspaceName("/workspaces/research"); // "research" */
export const workspaceName = (root: string) =>
  root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;

/** Reads the registered root without opening file contents. @example useQuery(workspaceQueryOptions(transport, id)); */
export function workspaceQueryOptions(transport: AppTransport, id: string) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load workspace" },
    queryKey: [["resources", "workspace", "get"], transport.url, id] as const,
    queryFn: ({ signal }) =>
      transport.rpc.resources.workspace.get.query({ id }, { signal }),
    retry: false,
  });
}

/** Reads every registry page through Resource; cancellation stops pagination. @example useQuery(workspacesQueryOptions(transport)); */
export function workspacesQueryOptions(transport: AppTransport) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load workspaces" },
    queryKey: [["resources", "workspace", "list"], transport.url] as const,
    queryFn: async ({ signal }) => {
      const items: Array<
        Awaited<
          ReturnType<
            AppTransport["rpc"]["resources"]["workspace"]["list"]["query"]
          >
        >["items"][number]
      > = [];
      let cursor: string | undefined;
      do {
        signal.throwIfAborted();
        const page = await transport.rpc.resources.workspace.list.query(
          { limit: 100, cursor },
          { signal },
        );
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return items;
    },
    retry: false,
  });
}

/** Recursively lists flat file and directory paths with availability status. @example useQuery(workspaceTreeQueryOptions(transport, id)); */
export function workspaceTreeQueryOptions(
  transport: AppTransport,
  workspaceId: string,
) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load workspace files" },
    queryKey: [
      ...workspaceQueryKeys.workspace(transport.url, workspaceId),
      "tree",
    ] as const,
    queryFn: ({ signal }) =>
      transport.rpc.workspace.listTree.query({ workspaceId }, { signal }),
    retry: false,
  });
}

/** Reads a single directory; active Query consumers automatically receive changes. @example useQuery(workspaceDirectoryQueryOptions(transport, id, path)); */
export function workspaceDirectoryQueryOptions(
  transport: AppTransport,
  workspaceId: string,
  path: string,
) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t load workspace files" },
    queryKey: [
      ...workspaceQueryKeys.workspace(transport.url, workspaceId),
      "directory",
      path,
    ] as const,
    queryFn: ({ signal }) =>
      transport.rpc.workspace.listDirectory.query(
        { workspaceId, path },
        { signal },
      ),
    retry: false,
    staleTime: 0,
  });
}

/** Reads file bytes as Base64 with their MIME type and hash; consumers own decoding and unsaved editor buffers. @example useQuery(workspaceFileQueryOptions(transport, id, "main.tea")); */
export function workspaceFileQueryOptions(
  transport: AppTransport,
  workspaceId: string,
  path: string,
) {
  return queryOptions({
    meta: { errorTitle: "Couldn’t read this file" },
    queryKey: [
      ...workspaceQueryKeys.workspace(transport.url, workspaceId),
      "file",
      path,
    ] as const,
    queryFn: ({ signal }) =>
      transport.rpc.workspace.read.query({ workspaceId, path }, { signal }),
    retry: false,
  });
}

/**
 * Copy a file's current disk text beside it as `<name>-copy[-N]<extensions>`, keeping every
 * extension (`a.workflow.ts` → `a-copy.workflow.ts`) so relative imports and file kinds still
 * resolve. The write is create-only: a concurrent name collision rejects instead of
 * overwriting, and callers may retry. Only UTF-8 text files can be copied.
 * @example const copy = await duplicateWorkspaceFile(transport, { workspaceId, path: "rsi.tea" });
 */
export async function duplicateWorkspaceFile(
  transport: AppTransport,
  source: { workspaceId: string; path: string },
) {
  // The copy lands beside its source, so only that directory's names can collide.
  const [file, siblings] = await Promise.all([
    transport.rpc.workspace.read.query(source),
    transport.rpc.workspace.listDirectory.query({
      workspaceId: source.workspaceId,
      path: source.path.split("/").slice(0, -1).join("/"),
    }),
  ]);
  if (siblings.status !== "ready")
    throw new Error("The workspace is unavailable");
  // Lower-cased: a case-insensitive disk (default macOS) treats RSI-copy.tea as taken too.
  const taken = new Set<string>(
    [
      ...siblings.entries.map((entry) => entry.path),
      ...siblings.directories,
    ].map((path) => path.toLowerCase()),
  );
  const dot = source.path.indexOf(".", source.path.lastIndexOf("/") + 2);
  const stem = dot < 0 ? source.path : source.path.slice(0, dot);
  const extension = dot < 0 ? "" : source.path.slice(dot);
  let path = `${stem}-copy${extension}`;
  for (let index = 2; taken.has(path.toLowerCase()); index++)
    path = `${stem}-copy-${index}${extension}`;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0)),
  );
  await transport.rpc.workspace.write.mutate({
    workspaceId: source.workspaceId,
    path,
    text,
    expected: null,
  });
  return { workspaceId: source.workspaceId, path };
}

async function refresh(queryClient: QueryClient, queryKey: readonly unknown[]) {
  await queryClient.cancelQueries({ queryKey });
  await queryClient.invalidateQueries({ queryKey });
}

/** Pick and register an existing folder; cancellation leaves the registry unchanged. Never retries native dialogs or writes. @example const create = useCreateWorkspace(transport, pickDirectory); create.mutate(); */
export function useCreateWorkspace(
  transport: AppTransport,
  pickDirectory: AppHost["pickDirectory"],
) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t create workspace" },
    mutationFn: async () => {
      const root = await pickDirectory();
      if (root === null) return null;
      return transport.rpc.resources.workspace.register.mutate({ root });
    },
    retry: false,
    onSettled: (workspace) =>
      workspace === null
        ? undefined
        : refresh(queryClient, workspacesQueryOptions(transport).queryKey),
  });
}

/** Forget a registration without deleting disk files. Success releases the view before registry/file refresh; failures retain it for retry. @example const forget = useForgetWorkspace(transport, closeTabs); forget.mutate(id); */
export function useForgetWorkspace(
  transport: AppTransport,
  onForgot: (workspaceId: string) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn’t forget workspace" },
    mutationFn: (id: string) =>
      transport.rpc.resources.workspace.forget.mutate({ id }),
    retry: false,
    onSuccess: (_, id) => onForgot(id),
    onSettled: (_, _error, id) =>
      Promise.all([
        refresh(queryClient, [["resources", "workspace"]]),
        refresh(queryClient, workspaceQueryKeys.workspace(transport.url, id)),
      ]).then(() => undefined),
  });
}

/** Writes without optimistic updates or retries; successful and failed writes both refresh disk state. onRemoved releases deleted views before refresh. Refresh errors belong to queries, separately from mutation errors. @example const { write } = useWorkspaceFileMutations(transport, id); write.mutate({ path: "main.tea", text, expected: hash }); */
export function useWorkspaceFileMutations(
  transport: AppTransport,
  workspaceId: string,
  onRemoved?: (path: string) => void,
) {
  const queryClient = useQueryClient();
  const onSettled = () =>
    refresh(
      queryClient,
      workspaceQueryKeys.workspace(transport.url, workspaceId),
    );
  const write = useMutation({
    mutationFn: (
      input: Omit<Parameters<FileRpc["write"]["mutate"]>[0], "workspaceId">,
    ) => transport.rpc.workspace.write.mutate({ workspaceId, ...input }),
    retry: false,
    onSettled,
  });
  const remove = useMutation({
    meta: { errorTitle: "Couldn’t delete file" },
    mutationFn: (
      input: Omit<Parameters<FileRpc["remove"]["mutate"]>[0], "workspaceId">,
    ) => transport.rpc.workspace.remove.mutate({ workspaceId, ...input }),
    retry: false,
    onSuccess: (_, input) => onRemoved?.(input.path),
    onSettled,
  });
  // Files and folders move whole; a rename never changes contents, so no hash guards it.
  const move = useMutation({
    meta: { errorTitle: "Couldn’t move" },
    mutationFn: (
      input: Omit<Parameters<FileRpc["rename"]["mutate"]>[0], "workspaceId">,
    ) => transport.rpc.workspace.rename.mutate({ workspaceId, ...input }),
    retry: false,
    onSettled,
  });
  const mkdir = useMutation({
    mutationFn: (
      input: Omit<Parameters<FileRpc["mkdir"]["mutate"]>[0], "workspaceId">,
    ) => transport.rpc.workspace.mkdir.mutate({ workspaceId, ...input }),
    retry: false,
    onSettled,
  });
  const removeDirectory = useMutation({
    meta: { errorTitle: "Couldn’t delete folder" },
    mutationFn: (path: string) =>
      transport.rpc.workspace.removeDirectory.mutate({ workspaceId, path }),
    retry: false,
    onSuccess: (_, path) => onRemoved?.(path),
    onSettled,
  });
  return { write, remove, move, mkdir, removeDirectory };
}

const ResourceChanged = z.object({ resource: z.string() });

/** Restarts file reads after index/registry changes and reconnect; unsubscribe releases this observer's SSE share. Registry queries use the existing Resource observer. @example const subscription = subscribeWorkspaceInvalidation(transport, queryClient); */
export function subscribeWorkspaceInvalidation(
  transport: AppTransport,
  queryClient: QueryClient,
  onError: (error: unknown) => void = console.error,
) {
  const observation = observeWorkspaceQueries(transport, queryClient, onError);
  const subscription = transport.events
    .pipe(
      filter(
        (frame) =>
          frame.kind === "ready" ||
          (frame.kind === "event" &&
            (frame.event.type === "workspace.changed" ||
              (frame.event.type === "resource.changed" &&
                ResourceChanged.parse(frame.event.data).resource ===
                  "workspace"))),
      ),
    )
    .subscribe({
      next: () => {
        void refresh(queryClient, workspaceQueryKeys.all).catch(onError);
      },
      error: onError,
    });
  subscription.add(observation);
  return subscription;
}
