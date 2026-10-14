// Purpose: Verify complete metadata ordering, cancellation, and authoritative query invalidations.

import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { CODEX } from "@openchart/models/model-tiers";

import {
  agentQueryKeys,
  providerSetupQueryOptions,
  sessionsQueryOptions,
  subscribeQueryInvalidation,
} from "@openchart/app/lib/agent/queries";
import { createAgentClient } from "@openchart/app/lib/agent/client";
import {
  resourceQueryKeys,
  subscribeResourceInvalidation,
} from "@openchart/app/lib/resource/invalidation";
import {
  createTransport,
  type AppEventFrame,
} from "@openchart/app/lib/transport/transport";

const rpc = vi.hoisted(() => ({
  events: { subscribe: { subscribe: vi.fn() } },
  models: {
    list: { query: vi.fn(async () => []) },
    setupState: { query: vi.fn() },
  },
  agent: {
    requestSnapshot: { mutate: vi.fn() },
    listSessions: { query: vi.fn() },
  },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));

const session = (
  id: string,
  updatedAt: number,
  parentId: string | null = null,
) => ({
  id,
  parentId,
  title: id,
  createdAt: 1,
  updatedAt,
  isUnread: false,
  isActive: false,
});
const connection = { origin: "http://127.0.0.1:43873" };
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.clearAllMocks();
});

it("refreshes composer setup progress when model jobs change", async () => {
  const remote = createAgentClient(createTransport(connection));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  cleanup.push(() => client.clear());
  let listener!: { onData: (frame: AppEventFrame) => void };
  rpc.events.subscribe.subscribe.mockImplementation((_input, callbacks) => {
    listener = callbacks;
    return { unsubscribe: vi.fn() };
  });
  const subscription = subscribeQueryInvalidation(remote, client);
  cleanup.push(() => subscription.unsubscribe());
  rpc.models.setupState.query.mockResolvedValue({ status: "idle" });
  const observer = new QueryObserver(
    client,
    providerSetupQueryOptions(remote.transport, CODEX),
  );
  cleanup.push(observer.subscribe(() => {}));
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toEqual({ status: "idle" }),
  );
  rpc.models.setupState.query.mockResolvedValue({
    status: "running",
    id: "setup",
    action: "install",
    output: "Downloading…",
  });
  listener.onData({
    kind: "event",
    event: { id: "evt_setup" as never, type: "models.changed", data: {} },
  });
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toMatchObject({
      status: "running",
      action: "install",
    }),
  );
  rpc.models.setupState.query.mockResolvedValue({
    status: "succeeded",
    id: "setup",
    action: "install",
    output: "Installed.",
  });
  listener.onData({
    kind: "event",
    event: { id: "evt_done" as never, type: "models.changed", data: {} },
  });
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toMatchObject({
      status: "succeeded",
    }),
  );
});

it("loads fifteen Sessions on demand and refreshes only loaded pages", async () => {
  const remote = createAgentClient(createTransport(connection));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cleanup.push(() => client.clear());
  const items = Array.from({ length: 31 }, (_, index) =>
    session(`ses_${index}`, 31 - index),
  );
  rpc.agent.listSessions.query.mockImplementation(async ({ limit, cursor }) => {
    const offset = Number(cursor ?? 0);
    return {
      items: items.slice(offset, offset + limit),
      nextCursor: offset + limit < items.length ? String(offset + limit) : null,
    };
  });
  const observer = new InfiniteQueryObserver(
    client,
    sessionsQueryOptions(remote),
  );
  cleanup.push(observer.subscribe(() => {}));
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toEqual(items.slice(0, 15)),
  );
  expect(rpc.agent.listSessions.query).toHaveBeenCalledOnce();
  await observer.fetchNextPage();
  expect(observer.getCurrentResult().data).toEqual(items.slice(0, 30));
  expect(observer.getCurrentResult().hasNextPage).toBe(true);
  await observer.refetch();
  expect(
    rpc.agent.listSessions.query.mock.calls.map(([input]) => input),
  ).toEqual([
    { limit: 15, cursor: undefined, orderBy: "updatedAt" },
    { limit: 15, cursor: "15", orderBy: "updatedAt" },
    { limit: 15, cursor: undefined, orderBy: "updatedAt" },
    { limit: 15, cursor: "15", orderBy: "updatedAt" },
  ]);
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();
  expect(rpc.events.subscribe.subscribe).not.toHaveBeenCalled();
});

it("aborts cancelled page requests and rejects malformed metadata", async () => {
  const remote = createAgentClient(createTransport(connection));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  cleanup.push(() => client.clear());
  let signal: AbortSignal | undefined;
  rpc.agent.listSessions.query.mockImplementationOnce((_input, request) => {
    signal = request.signal;
    return new Promise(() => {});
  });
  const pending = client
    .fetchInfiniteQuery(sessionsQueryOptions(remote))
    .catch(() => undefined);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await client.cancelQueries({
    queryKey: agentQueryKeys.sessions(remote.transport.url),
  });
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(rpc.agent.listSessions.query).toHaveBeenCalledOnce();
  rpc.agent.listSessions.query.mockResolvedValueOnce({
    items: [{ id: "ses_bad" }],
    nextCursor: null,
  });
  await expect(
    client.fetchInfiniteQuery(sessionsQueryOptions(remote)),
  ).rejects.toThrow();
});

it("restarts an initial pending query after metadata changes and invalidates nested Resource prefixes", async () => {
  const remote = createAgentClient(createTransport(connection));
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
    },
  });
  cleanup.push(() => queryClient.clear());
  let listener!: { onData: (frame: AppEventFrame) => void };
  rpc.events.subscribe.subscribe.mockImplementation((_input, callbacks) => {
    listener = callbacks;
    return { unsubscribe: vi.fn() };
  });
  const errors = vi.fn();
  const subscription = subscribeQueryInvalidation(remote, queryClient, errors);
  cleanup.push(() => subscription.unsubscribe());
  const resources = subscribeResourceInvalidation(
    remote.transport,
    queryClient,
    errors,
  );
  cleanup.push(() => resources.unsubscribe());
  let resolveOld!: (value: unknown) => void;
  rpc.agent.listSessions.query
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue({ items: [session("ses_fresh", 2)], nextCursor: null });
  const observer = new InfiniteQueryObserver(
    queryClient,
    sessionsQueryOptions(remote),
  );
  cleanup.push(observer.subscribe(() => {}));
  await vi.waitFor(() =>
    expect(rpc.agent.listSessions.query).toHaveBeenCalledOnce(),
  );
  listener.onData({
    kind: "event",
    event: {
      id: "evt_session" as never,
      type: "agent.event",
      data: {
        sessionID: "ses_fresh",
        event: {
          type: "STATE_DELTA",
          delta: [
            { op: "add", path: "/session", value: session("ses_fresh", 2) },
          ],
        },
      },
    },
  });
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toEqual([session("ses_fresh", 2)]),
  );
  resolveOld({ items: [session("ses_stale", 1)], nextCursor: null });
  await Promise.resolve();
  expect(observer.getCurrentResult().data).toEqual([session("ses_fresh", 2)]);

  const chartKey = [
    ["resources", "chart", "get"],
    { input: { id: "cht_one" } },
  ] as const;
  const dashboardKey = [
    ["resources", "dashboard", "list"],
    { input: {} },
  ] as const;
  queryClient.setQueryData(chartKey, "before");
  queryClient.setQueryData(dashboardKey, "untouched");
  const fetchChart = vi.fn(async () => "after");
  const fetchDashboard = vi.fn(async () => "reconnected");
  const chart = new QueryObserver(queryClient, {
    queryKey: chartKey,
    queryFn: fetchChart,
  });
  const dashboard = new QueryObserver(queryClient, {
    queryKey: dashboardKey,
    queryFn: fetchDashboard,
  });
  cleanup.push(
    chart.subscribe(() => {}),
    dashboard.subscribe(() => {}),
  );
  const changed: AppEventFrame = {
    kind: "event",
    event: {
      id: "evt_resource" as never,
      type: "resource.changed",
      data: { resource: "chart", id: "cht_one", revision: 1 },
    },
  };
  listener.onData(changed);
  await vi.waitFor(() => expect(fetchChart).toHaveBeenCalledOnce());
  expect(fetchDashboard).not.toHaveBeenCalled();
  listener.onData(changed);
  await vi.waitFor(() => expect(fetchChart).toHaveBeenCalledTimes(2));
  listener.onData({ kind: "ready" });
  await vi.waitFor(() => expect(fetchDashboard).toHaveBeenCalledOnce());
  expect(
    queryClient.getQueryData(sessionsQueryOptions(remote).queryKey),
  ).toEqual({
    pages: [{ items: [session("ses_fresh", 2)], nextCursor: null }],
    pageParams: [undefined],
  });
  expect(resourceQueryKeys.resource("chart")).toEqual([["resources", "chart"]]);
  expect(errors).not.toHaveBeenCalled();
});
