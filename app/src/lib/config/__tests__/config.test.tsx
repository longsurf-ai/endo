// Purpose: Verify Config query cancellation and honest mutation/refetch status.
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { useConfig } from "@openchart/app/hooks/use-config";
import {
  configQueryOptions,
  subscribeConfigInvalidation,
} from "@openchart/app/lib/config/config";
import {
  createTransport,
  type AppEventFrame,
} from "@openchart/app/lib/transport/transport";

const rpc = vi.hoisted(() => ({
  events: { subscribe: { subscribe: vi.fn() } },
  config: { get: { query: vi.fn() }, update: { mutate: vi.fn() } },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose();
  vi.clearAllMocks();
});
const settings = (theme: string) => ({ appearance: { theme } });
function setup() {
  const transport = createTransport({ origin: "http://127.0.0.1:41000" });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  cleanups.push(() => client.clear());
  return { transport, client };
}

test("config events and readiness restart pending reads and discard old responses", async () => {
  const { transport, client } = setup();
  let onData!: (frame: AppEventFrame) => void;
  rpc.events.subscribe.subscribe.mockImplementation((_input, callbacks) => {
    onData = callbacks.onData;
    return { unsubscribe: vi.fn() };
  });
  const subscription = subscribeConfigInvalidation(transport, client);
  cleanups.push(() => subscription.unsubscribe());
  let resolveOld!: (value: unknown) => void;
  rpc.config.get.query
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(settings("dark"));
  const observer = new QueryObserver(client, configQueryOptions(transport));
  cleanups.push(observer.subscribe(() => {}));
  await vi.waitFor(() => expect(rpc.config.get.query).toHaveBeenCalledOnce());
  onData({
    kind: "event",
    event: { id: "evt_config" as never, type: "config.changed", data: {} },
  });
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toEqual(settings("dark")),
  );
  resolveOld(settings("light"));
  await Promise.resolve();
  expect(observer.getCurrentResult().data).toEqual(settings("dark"));
  onData({ kind: "ready" });
  await vi.waitFor(() => expect(rpc.config.get.query).toHaveBeenCalledTimes(3));
  expect(rpc.config.get.query.mock.calls[0]![1].signal.aborted).toBe(true);
});

test("saves have no optimistic state; a successful commit and failed refresh remain distinct, and failed saves are not retried", async () => {
  const { transport, client } = setup();
  rpc.config.get.query.mockResolvedValue(settings("light"));
  let commit!: () => void;
  rpc.config.update.mutate.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        commit = resolve;
      }),
  );
  const view = renderHook(() => useConfig(transport), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  cleanups.push(view.unmount);
  await waitFor(() =>
    expect(view.result.current.config).toEqual(settings("light")),
  );
  act(() => view.result.current.update({ appearance: { theme: "dark" } }));
  await waitFor(() => expect(view.result.current.isSaving).toBe(true));
  expect(view.result.current.config).toEqual(settings("light"));
  rpc.config.get.query.mockRejectedValue(new Error("refresh failed"));
  await act(async () => {
    commit();
  });
  await waitFor(() => expect(view.result.current.isSaved).toBe(true));
  expect(view.result.current.readError?.message).toBe("refresh failed");
  expect(view.result.current.saveError).toBeNull();
  rpc.config.update.mutate.mockRejectedValue(new Error("response lost"));
  rpc.config.get.query.mockResolvedValue(settings("dark"));
  act(() => view.result.current.update({ appearance: { theme: "dark" } }));
  await waitFor(() =>
    expect(view.result.current.saveError?.message).toBe("response lost"),
  );
  await waitFor(() =>
    expect(view.result.current.config).toEqual(settings("dark")),
  );
  expect(rpc.config.update.mutate).toHaveBeenCalledTimes(2);
});
