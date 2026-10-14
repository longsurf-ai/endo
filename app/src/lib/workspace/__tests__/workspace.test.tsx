// Purpose: Verifies Workspace Query invalidation and separate save/read failure states.

import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  useQuery,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  createTransport,
  type AppEventFrame,
} from "@openchart/app/lib/transport/transport";
import { subscribeResourceInvalidation } from "@openchart/app/lib/resource/invalidation";
import { observeWorkspaceQueries } from "@openchart/app/lib/workspace/workspace-observation";
import {
  workspaceFileQueryOptions,
  workspacesQueryOptions,
  subscribeWorkspaceInvalidation,
  useWorkspaceFileMutations,
  useCreateWorkspace,
  defaultWorkspaceQueryOptions,
  duplicateWorkspaceFile,
  workspaceQueryKeys,
} from "@openchart/app/lib/workspace/workspace";

const rpc = vi.hoisted(() => ({
  events: { subscribe: { subscribe: vi.fn() } },
  resources: {
    workspace: {
      list: { query: vi.fn() },
      getDefault: { query: vi.fn() },
      register: { mutate: vi.fn() },
    },
  },
  workspace: {
    watch: { subscribe: vi.fn() },
    read: { query: vi.fn() },
    listDirectory: { query: vi.fn() },
    write: { mutate: vi.fn() },
    remove: { mutate: vi.fn() },
    rename: { mutate: vi.fn() },
  },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose();
  vi.resetAllMocks();
});
const file = (text: string) => ({
  entry: { path: "main.tea", hash: text },
  mediaType: "text/plain",
  readOnly: false,
  base64: btoa(text),
});
function setup() {
  rpc.workspace.watch.subscribe.mockReturnValue({ unsubscribe: vi.fn() });
  const transport = createTransport({ origin: "http://127.0.0.1:41000" });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  cleanups.push(() => client.clear());
  return { transport, client };
}

test("folder selection registers once and refreshes the workspace directory; cancel does neither", async () => {
  const { transport, client } = setup();
  const options = workspacesQueryOptions(transport);
  client.setQueryData(options.queryKey, []);
  const pickDirectory = vi
    .fn<() => Promise<string | null>>()
    .mockResolvedValue(null);
  const { result } = renderHook(
    () => useCreateWorkspace(transport, pickDirectory),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    expect(await result.current.mutateAsync()).toBeNull();
  });
  expect(rpc.resources.workspace.register.mutate).not.toHaveBeenCalled();
  expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(false);
  pickDirectory.mockResolvedValue("/chosen/folder");
  const workspace = { id: "wsp_new", root: "/chosen/folder" };
  rpc.resources.workspace.register.mutate.mockResolvedValue(workspace);
  await act(async () => {
    expect(await result.current.mutateAsync()).toEqual(workspace);
  });
  expect(
    rpc.resources.workspace.register.mutate,
  ).toHaveBeenCalledExactlyOnceWith({ root: "/chosen/folder" });
  expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
});

test("folder picker and registration failures propagate without retrying", async () => {
  const { transport, client } = setup();
  const pickDirectory = vi
    .fn<() => Promise<string | null>>()
    .mockRejectedValueOnce(new Error("Picker failed"));
  const { result } = renderHook(
    () => useCreateWorkspace(transport, pickDirectory),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  await act(async () => {
    await expect(result.current.mutateAsync()).rejects.toThrow("Picker failed");
  });
  expect(pickDirectory).toHaveBeenCalledOnce();
  expect(rpc.resources.workspace.register.mutate).not.toHaveBeenCalled();
  pickDirectory.mockResolvedValue("/chosen/folder");
  rpc.resources.workspace.register.mutate.mockRejectedValueOnce(
    new Error("Workspace already registered"),
  );
  await act(async () => {
    await expect(result.current.mutateAsync()).rejects.toThrow(
      "Workspace already registered",
    );
  });
  expect(pickDirectory).toHaveBeenCalledTimes(2);
  expect(rpc.resources.workspace.register.mutate).toHaveBeenCalledOnce();
});

test("file/registry changes and reconnect restart reads on the same SSE connection", async () => {
  const { transport, client } = setup();
  let onData!: (frame: AppEventFrame) => void;
  rpc.events.subscribe.subscribe.mockImplementation((_input, callbacks) => {
    onData = callbacks.onData;
    return { unsubscribe: vi.fn() };
  });
  const files = subscribeWorkspaceInvalidation(transport, client);
  const registry = subscribeResourceInvalidation(transport, client);
  cleanups.push(
    () => files.unsubscribe(),
    () => registry.unsubscribe(),
  );
  rpc.resources.workspace.list.query.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  rpc.resources.workspace.getDefault.query.mockResolvedValue("wsp_test");
  let resolveOld!: (value: unknown) => void;
  rpc.workspace.read.query
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(file("new"));
  const content = new QueryObserver(
    client,
    workspaceFileQueryOptions(transport, "wsp_test", "main.tea"),
  );
  const roots = new QueryObserver(client, workspacesQueryOptions(transport));
  const defaultWorkspace = new QueryObserver(
    client,
    defaultWorkspaceQueryOptions(transport),
  );
  cleanups.push(
    content.subscribe(() => {}),
    roots.subscribe(() => {}),
    defaultWorkspace.subscribe(() => {}),
  );
  await waitFor(() => expect(rpc.workspace.read.query).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(defaultWorkspace.getCurrentResult().data).toBe("wsp_test"),
  );
  onData({
    kind: "event",
    event: { id: "evt_file" as never, type: "workspace.changed", data: {} },
  });
  await waitFor(() =>
    expect(content.getCurrentResult().data).toEqual(file("new")),
  );
  resolveOld(file("old"));
  await Promise.resolve();
  expect(content.getCurrentResult().data).toEqual(file("new"));
  expect(rpc.workspace.read.query.mock.calls[0]![1].signal.aborted).toBe(true);
  onData({
    kind: "event",
    event: {
      id: "evt_root" as never,
      type: "resource.changed",
      data: { resource: "workspace" },
    },
  });
  await waitFor(() =>
    expect(rpc.workspace.read.query).toHaveBeenCalledTimes(3),
  );
  await waitFor(() =>
    expect(rpc.resources.workspace.list.query).toHaveBeenCalledTimes(2),
  );
  await waitFor(() =>
    expect(rpc.resources.workspace.getDefault.query).toHaveBeenCalledTimes(2),
  );
  onData({ kind: "ready" });
  await waitFor(() =>
    expect(rpc.workspace.read.query).toHaveBeenCalledTimes(4),
  );
  expect(rpc.resources.workspace.list.query).toHaveBeenCalledTimes(3);
  expect(rpc.resources.workspace.getDefault.query).toHaveBeenCalledTimes(3);
  expect(rpc.events.subscribe.subscribe).toHaveBeenCalledOnce();
});

test("save and refresh failures stay separate without optimistic text or retries", async () => {
  const { transport, client } = setup();
  rpc.workspace.read.query.mockResolvedValue(file("old"));
  let commit!: () => void;
  rpc.workspace.write.mutate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        commit = resolve;
      }),
  );
  const view = renderHook(
    () => ({
      read: useQuery(
        workspaceFileQueryOptions(transport, "wsp_test", "main.tea"),
      ),
      ...useWorkspaceFileMutations(transport, "wsp_test"),
    }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  cleanups.push(view.unmount);
  await waitFor(() =>
    expect(view.result.current.read.data).toEqual(file("old")),
  );
  act(() =>
    view.result.current.write.mutate({
      path: "main.tea",
      text: "new",
      expected: "old",
    }),
  );
  await waitFor(() => expect(view.result.current.write.isPending).toBe(true));
  expect(view.result.current.read.data).toEqual(file("old"));
  rpc.workspace.read.query.mockRejectedValue(new Error("refresh failed"));
  await act(async () => {
    commit();
  });
  await waitFor(() => expect(view.result.current.write.isSuccess).toBe(true));
  expect(view.result.current.read.error?.message).toBe("refresh failed");
  expect(view.result.current.write.error).toBeNull();
  rpc.workspace.write.mutate.mockRejectedValue(new Error("conflict"));
  rpc.workspace.read.query.mockResolvedValue(file("external"));
  act(() =>
    view.result.current.write.mutate({
      path: "main.tea",
      text: "new",
      expected: "old",
    }),
  );
  await waitFor(() =>
    expect(view.result.current.write.error?.message).toBe("conflict"),
  );
  await waitFor(() =>
    expect(view.result.current.read.data).toEqual(file("external")),
  );
  expect(rpc.workspace.write.mutate).toHaveBeenCalledTimes(2);
});

test.each([
  ["studies/rsi.tea", "studies/rsi-copy-2.tea"],
  ["studies/RSI.tea", "studies/RSI-copy-2.tea"],
  ["flows/daily.workflow.ts", "flows/daily-copy.workflow.ts"],
  ["notes.md", "notes-copy.md"],
  [".env", ".env-copy"],
  ["v1.2/rsi.tea", "v1.2/rsi-copy.tea"],
])(
  "duplicating %s writes %s create-only, keeping every extension",
  async (path, copy) => {
    const { transport } = setup();
    rpc.workspace.read.query.mockResolvedValue(file("text"));
    rpc.workspace.listDirectory.query.mockResolvedValue({
      status: "ready",
      entries: [
        { path },
        // Taken on a case-insensitive disk, whatever its spelling.
        { path: "studies/RSI-copy.tea" },
      ],
      directories: ["studies/archive"],
    });
    await expect(
      duplicateWorkspaceFile(transport, { workspaceId: "wsp_test", path }),
    ).resolves.toEqual({ workspaceId: "wsp_test", path: copy });
    expect(rpc.workspace.write.mutate).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "wsp_test",
      path: copy,
      text: "text",
      expected: null,
    });
    expect(rpc.workspace.listDirectory.query).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "wsp_test",
      path: path.split("/").slice(0, -1).join("/"),
    });
  },
);

test("active queries share one observation; disabling and unmounting release it", async () => {
  const { transport, client } = setup();
  const error = vi.fn();
  const observation = observeWorkspaceQueries(transport, client, error);
  cleanups.push(() => observation.unsubscribe());
  rpc.workspace.read.query.mockImplementation(
    async ({ path }: { path: string }) => ({
      ...file(path),
      entry: { path, hash: path },
    }),
  );
  const options = workspaceFileQueryOptions(transport, "wsp_test", "main.tea");
  const first = new QueryObserver(client, options);
  const second = new QueryObserver(client, options);
  const stopFirst = first.subscribe(() => {});
  const stopSecond = second.subscribe(() => {});
  cleanups.push(stopFirst, stopSecond);
  await waitFor(() =>
    expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce(),
  );
  expect(rpc.workspace.watch.subscribe.mock.calls[0]![0]).toEqual({
    interests: [
      { workspaceId: "wsp_test", target: { kind: "file", path: "main.tea" } },
    ],
  });
  const old = rpc.workspace.watch.subscribe.mock.calls[0]![1];
  const close =
    rpc.workspace.watch.subscribe.mock.results[0]!.value.unsubscribe;
  stopFirst();
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  second.setOptions({ ...options, enabled: false });
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  rpc.workspace.read.query.mockClear();
  old.onData({
    workspaceId: "wsp_test",
    target: { kind: "file", path: "main.tea" },
  });
  await Promise.resolve();
  expect(rpc.workspace.read.query).not.toHaveBeenCalled();
  second.setOptions(options);
  await waitFor(() =>
    expect(rpc.workspace.watch.subscribe).toHaveBeenCalledTimes(2),
  );
  const current = rpc.workspace.watch.subscribe.mock.calls[1]![1];
  current.onData({
    workspaceId: "wsp_test",
    target: { kind: "file", path: "main.tea" },
  });
  await waitFor(() => expect(rpc.workspace.read.query).toHaveBeenCalled());
  expect(error).not.toHaveBeenCalled();
});

test.each(["replace", "dispose"])(
  "%s discards late notifications and errors from the old subscription",
  async (action) => {
    const { transport, client } = setup();
    rpc.workspace.read.query.mockResolvedValue(file("disk"));
    const error = vi.fn();
    const observation = observeWorkspaceQueries(transport, client, error);
    cleanups.push(() => observation.unsubscribe());
    const query = new QueryObserver(
      client,
      workspaceFileQueryOptions(transport, "wsp_test", "main.tea"),
    );
    cleanups.push(query.subscribe(() => {}));
    await waitFor(() =>
      expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce(),
    );
    const [input, old] = rpc.workspace.watch.subscribe.mock.calls[0]!;
    const close =
      rpc.workspace.watch.subscribe.mock.results[0]!.value.unsubscribe;
    const invalidate = vi.spyOn(client, "invalidateQueries");

    if (action === "replace") {
      query.setOptions(
        workspaceFileQueryOptions(transport, "wsp_test", "other.tea"),
      );
      await waitFor(() =>
        expect(rpc.workspace.watch.subscribe).toHaveBeenCalledTimes(2),
      );
    } else {
      observation.unsubscribe();
    }
    expect(close).toHaveBeenCalledOnce();
    old.onData(input.interests[0]);
    old.onError(new Error("Obsolete connection"));
    expect(invalidate).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    if (action === "replace") {
      const [nextInput, current] = rpc.workspace.watch.subscribe.mock.calls[1]!;
      current.onData(nextInput.interests[0]);
      await waitFor(() => expect(invalidate).toHaveBeenCalledOnce());
    }
  },
);

test("each notification refreshes its own file and transport errors do not end observation", async () => {
  const { transport, client } = setup();
  rpc.workspace.read.query.mockResolvedValue(file("disk"));
  const error = vi.fn();
  const observation = observeWorkspaceQueries(transport, client, error);
  cleanups.push(() => observation.unsubscribe());
  for (const path of ["one.tea", "two.tea"]) {
    const query = new QueryObserver(
      client,
      workspaceFileQueryOptions(transport, "wsp_test", path),
    );
    cleanups.push(query.subscribe(() => {}));
  }
  await waitFor(() =>
    expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce(),
  );
  const [input, current] = rpc.workspace.watch.subscribe.mock.calls[0]!;
  expect(input.interests).toHaveLength(2);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  rpc.workspace.read.query.mockClear();
  input.interests.forEach(current.onData);
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      rpc.workspace.read.query.mock.calls.map(([read]) => read.path).sort(),
    ).toEqual(["one.tea", "two.tea"]),
  );

  const failure = new Error("Disconnected");
  current.onError(failure);
  expect(error).toHaveBeenCalledWith(failure);
  current.onData(input.interests[1]);
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(3));
  expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce();
});

test("a program read follows its entry, then every file it reached", async () => {
  const { transport, client } = setup();
  const error = vi.fn();
  const observation = observeWorkspaceQueries(transport, client, error);
  cleanups.push(() => observation.unsubscribe());
  type Program = { entry: string; sources: Record<string, string> };
  let finish!: (program: Program) => void;
  const read = vi
    .fn<() => Promise<Program>>()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ entry: "main.tea", sources: { "main.tea": "a" } });
  const query = new QueryObserver(client, {
    queryKey: workspaceQueryKeys.program(transport.url, "wsp_test", "main.tea"),
    queryFn: read,
  });
  cleanups.push(query.subscribe(() => {}));
  const watched = (...paths: string[]) => ({
    interests: paths.map((path) => ({
      workspaceId: "wsp_test",
      target: { kind: "file", path },
    })),
  });
  const latest = () => rpc.workspace.watch.subscribe.mock.lastCall;
  await waitFor(() => expect(latest()?.[0]).toEqual(watched("main.tea")));
  finish({
    entry: "main.tea",
    sources: { "main.tea": "a", "lib/ma.tea": "b" },
  });
  await waitFor(() =>
    expect(latest()?.[0]).toEqual(watched("main.tea", "lib/ma.tea")),
  );
  // Editing the import re-reads the program, which no longer imports it.
  latest()![1].onData(watched("lib/ma.tea").interests[0]);
  await waitFor(() => expect(latest()?.[0]).toEqual(watched("main.tea")));
  expect(read).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
});

test("a file notification supersedes an unfinished read while a program keeps its interest across reopen", async () => {
  const { transport, client } = setup();
  const error = vi.fn();
  const observation = observeWorkspaceQueries(transport, client, error);
  cleanups.push(() => observation.unsubscribe());
  // Another consumer can keep the file watched when its editor closes.
  const program = new QueryObserver(client, {
    queryKey: workspaceQueryKeys.program(transport.url, "wsp_test", "main.tea"),
    queryFn: async () => ({ sources: { "main.tea": "source" } }),
  });
  cleanups.push(program.subscribe(() => {}));
  await waitFor(() =>
    expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce(),
  );
  let finishOld!: (value: ReturnType<typeof file>) => void;
  rpc.workspace.read.query
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValue(file("new"));
  const query = new QueryObserver(
    client,
    workspaceFileQueryOptions(transport, "wsp_test", "main.tea"),
  );
  const close = query.subscribe(() => {});
  cleanups.push(close);
  await waitFor(() =>
    expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce(),
  );
  const [input, current] = rpc.workspace.watch.subscribe.mock.calls[0]!;
  current.onData(input.interests[0]);
  finishOld(file("old"));
  await waitFor(() =>
    expect(query.getCurrentResult().data).toEqual(file("new")),
  );
  expect(rpc.workspace.read.query.mock.calls[0]![1].signal.aborted).toBe(true);
  close();
  // Flush the interest update while only the program remains mounted.
  await Promise.resolve();
  const reopened = new QueryObserver(
    client,
    workspaceFileQueryOptions(transport, "wsp_test", "main.tea"),
  );
  cleanups.push(reopened.subscribe(() => {}));
  expect(reopened.getCurrentResult().data).toEqual(file("new"));
  expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
});

test("a notification keeps cached-read awaiters attached to the replacement fetch", async () => {
  const { transport, client } = setup();
  rpc.workspace.read.query.mockResolvedValueOnce(file("initial"));
  const error = vi.fn();
  const observation = observeWorkspaceQueries(transport, client, error);
  cleanups.push(() => observation.unsubscribe());
  const options = workspaceFileQueryOptions(transport, "wsp_test", "main.tea");
  const query = new QueryObserver(client, options);
  cleanups.push(query.subscribe(() => {}));
  await waitFor(() =>
    expect(query.getCurrentResult().data).toEqual(file("initial")),
  );
  await waitFor(() =>
    expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce(),
  );
  let finishOld!: (value: ReturnType<typeof file>) => void;
  let finishNew!: (value: ReturnType<typeof file>) => void;
  rpc.workspace.read.query
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
  const settled = vi.fn();
  const refresh = client
    .refetchQueries({ queryKey: options.queryKey })
    .then(() => {
      settled(query.getCurrentResult().data);
    });
  const [input, current] = rpc.workspace.watch.subscribe.mock.calls[0]!;
  current.onData(input.interests[0]);
  await waitFor(() =>
    expect(rpc.workspace.read.query).toHaveBeenCalledTimes(3),
  );
  expect(settled).not.toHaveBeenCalled();
  finishNew(file("latest"));
  await refresh;
  expect(settled).toHaveBeenCalledWith(file("latest"));
  finishOld(file("superseded"));
  await Promise.resolve();
  expect(query.getCurrentResult().data).toEqual(file("latest"));
  expect(error).not.toHaveBeenCalled();
});

test("disposing observation during read cancellation prevents a late refetch", async () => {
  const { transport, client } = setup();
  const error = vi.fn();
  rpc.workspace.read.query.mockResolvedValue(file("disk"));
  const observation = observeWorkspaceQueries(transport, client, error);
  cleanups.push(() => observation.unsubscribe());
  const query = new QueryObserver(
    client,
    workspaceFileQueryOptions(transport, "wsp_test", "main.tea"),
  );
  cleanups.push(query.subscribe(() => {}));
  await waitFor(() =>
    expect(query.getCurrentResult().data).toEqual(file("disk")),
  );
  await waitFor(() =>
    expect(rpc.workspace.watch.subscribe).toHaveBeenCalledOnce(),
  );
  let finishCancellation!: () => void;
  vi.spyOn(client, "cancelQueries").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishCancellation = resolve;
      }),
  );
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const [input, current] = rpc.workspace.watch.subscribe.mock.calls[0]!;
  current.onData(input.interests[0]);
  observation.unsubscribe();
  finishCancellation();
  await Promise.resolve();
  expect(invalidate).not.toHaveBeenCalled();
  expect(rpc.workspace.read.query).toHaveBeenCalledOnce();
  expect(error).not.toHaveBeenCalled();
});
