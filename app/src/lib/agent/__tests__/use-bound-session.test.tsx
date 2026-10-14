// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { expect, it, vi } from "vitest";

import { AgentProvider } from "@openchart/app/lib/agent/provider";
import type { SessionSnapshot } from "@openchart/app/lib/agent/session-store";
import type { Agent } from "@openchart/app/lib/agent/use-agent";
import { useBoundSession } from "@openchart/app/lib/agent/use-bound-session";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

function setup() {
  const readBinding = vi.fn(async ({ key }: { key: string }) =>
    key === "missing" ? null : { id: key },
  );
  const transport = {
    url: "http://bound-session.test",
    rpc: { agent: { getSessionByBinding: { query: readBinding } } },
  } as unknown as AppTransport;
  const snapshot: SessionSnapshot = {
    messages: [],
    subagents: {},
    state: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: "Observation offline",
  };
  const listeners = new Map<string, Set<() => void>>();
  const cancel = vi.fn();
  const getSession = vi.fn((id: string) => ({
    id,
    loadOlder: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      const current = listeners.get(id) ?? new Set<() => void>();
      listeners.set(id, current);
      current.add(listener);
      return () => {
        current.delete(listener);
      };
    },
    cancel,
  }));
  const bind = vi.fn();
  const submit = vi.fn();
  const agent = {
    getSession,
    getOrCreateBoundSession: { mutateAsync: bind },
    submitPrompt: { mutateAsync: submit },
  } as unknown as Agent;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <StrictMode>
        <QueryClientProvider client={client}>
          <AgentProvider agent={agent}>{children}</AgentProvider>
        </QueryClientProvider>
      </StrictMode>
    );
  }
  return {
    transport,
    readBinding,
    getSession,
    listeners,
    cancel,
    bind,
    submit,
    client,
    Wrapper,
  };
}

it("leaves a missing binding unobserved without creating or executing a Session", async () => {
  const test = setup();
  const view = renderHook(() => useBoundSession(test.transport, "missing"), {
    wrapper: test.Wrapper,
  });
  await waitFor(() => expect(test.readBinding).toHaveBeenCalled());
  await waitFor(() => expect(test.client.isFetching()).toBe(0));
  expect(view.result.current).toMatchObject({
    progress: undefined,
    error: null,
    retry: undefined,
  });
  expect(test.getSession).not.toHaveBeenCalled();
  expect(test.bind).not.toHaveBeenCalled();
  expect(test.submit).not.toHaveBeenCalled();
  view.unmount();
  test.client.clear();
});

it("retries lookup failures and detaches the previous Session when the binding changes", async () => {
  const test = setup();
  test.readBinding.mockRejectedValue(new Error("Binding offline"));
  const view = renderHook(({ key }) => useBoundSession(test.transport, key), {
    initialProps: { key: "ses_first" },
    wrapper: test.Wrapper,
  });
  await waitFor(() =>
    expect(view.result.current.error?.message).toBe("Binding offline"),
  );
  expect(test.getSession).not.toHaveBeenCalled();
  test.readBinding.mockImplementation(async ({ key }) => ({ id: key }));
  act(() => view.result.current.retry!());
  await waitFor(() =>
    expect(view.result.current.error?.message).toBe("Observation offline"),
  );
  expect(view.result.current.retry).toBeUndefined();
  expect(test.listeners.get("ses_first")?.size).toBe(1);
  view.rerender({ key: "ses_second" });
  await waitFor(() => expect(test.listeners.get("ses_second")?.size).toBe(1));
  expect(test.listeners.get("ses_first")?.size).toBe(0);
  view.unmount();
  expect(test.listeners.get("ses_second")?.size).toBe(0);
  expect(test.cancel).not.toHaveBeenCalled();
  expect(test.bind).not.toHaveBeenCalled();
  expect(test.submit).not.toHaveBeenCalled();
  test.client.clear();
});
