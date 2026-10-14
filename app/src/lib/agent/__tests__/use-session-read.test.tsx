// @vitest-environment jsdom
// Purpose: Keep unread results until their conversation is visible and focused.
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionSnapshot } from "@openchart/app/lib/agent/session-store";
import type { SessionState } from "@openchart/app/lib/agent/client";
import { useSessionRead } from "@openchart/app/lib/agent/use-session-read";

afterEach(() => vi.restoreAllMocks());

function snapshot(
  status: SessionState["runs"][number]["status"] = "completed",
  id = "agr_1",
): SessionSnapshot {
  return {
    messages: [],
    subagents: {},
    loading: false,
    error: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    state: {
      session: {
        id: "ses_1" as SessionState["session"]["id"],
        kind: "chat",
        title: "Chat",
        parentId: null,
        bindingId: null,
        anchors: null,
        compactingAt: null,
        archivedAt: null,
        lastReadRunId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      runs: [
        {
          id: id as SessionState["runs"][number]["id"],
          sessionID: "ses_1",
          sessionIntentID: id,
          status,
          queuePosition: status === "queued" ? 0 : null,
          createdAt: 1,
          startedAt: status === "queued" ? null : 1,
          finishedAt: status === "running" || status === "queued" ? null : 2,
        },
      ],
      questions: [],
      permissions: [],
      messageInfo: {},
      history: { nextCursor: null },
    },
  };
}

test("acknowledges displayed results on opening/focus and stops when hidden or unmounted", async () => {
  const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const agent = { markSessionRead: { mutate: vi.fn() } };
  const view = renderHook(
    ({ value, visible }) =>
      useSessionRead(agent.markSessionRead.mutate, value, visible),
    { initialProps: { value: snapshot(), visible: false } },
  );
  view.rerender({ value: snapshot(), visible: true });
  expect(agent.markSessionRead.mutate).not.toHaveBeenCalled();
  focused.mockReturnValue(true);
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(agent.markSessionRead.mutate).toHaveBeenCalledExactlyOnceWith({
    runId: "agr_1",
  });
  const acknowledged = snapshot();
  acknowledged.state!.session.lastReadRunId = "agr_1";
  view.rerender({ value: acknowledged, visible: true });
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(agent.markSessionRead.mutate).toHaveBeenCalledTimes(1);
  view.rerender({ value: snapshot("running", "agr_2"), visible: true });
  expect(agent.markSessionRead.mutate).toHaveBeenCalledTimes(1);
  view.rerender({ value: snapshot("completed", "agr_2"), visible: false });
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(agent.markSessionRead.mutate).toHaveBeenCalledTimes(1);
  view.rerender({ value: snapshot("completed", "agr_2"), visible: true });
  expect(agent.markSessionRead.mutate).toHaveBeenLastCalledWith({
    runId: "agr_2",
  });
  focused.mockReturnValue(false);
  view.rerender({ value: snapshot("completed", "agr_3"), visible: true });
  view.unmount();
  focused.mockReturnValue(true);
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(agent.markSessionRead.mutate).toHaveBeenCalledTimes(2);
});

test("loading, absent snapshots, active Runs and already-read positions stay unchanged", () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const agent = { markSessionRead: { mutate: vi.fn() } };
  const read = snapshot();
  read.state!.session.lastReadRunId = "agr_2";
  const view = renderHook(
    (value) => useSessionRead(agent.markSessionRead.mutate, value, true),
    { initialProps: { ...snapshot(), loading: true } },
  );
  for (const value of [
    { ...snapshot(), state: undefined },
    snapshot("running"),
    snapshot("queued"),
    read,
  ])
    view.rerender(value);
  expect(agent.markSessionRead.mutate).not.toHaveBeenCalled();
  view.rerender({ ...snapshot("failed"), error: "Execution failed" });
  expect(agent.markSessionRead.mutate).toHaveBeenCalledWith({
    runId: "agr_1",
  });
});

test("background windows acknowledge the observed result only when visible again", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  const agent = { markSessionRead: { mutate: vi.fn() } };
  renderHook(() =>
    useSessionRead(agent.markSessionRead.mutate, snapshot(), true),
  );
  expect(agent.markSessionRead.mutate).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(agent.markSessionRead.mutate).toHaveBeenCalledWith({
    runId: "agr_1",
  });
});

test("focus retries an unacknowledged read until the persisted watermark arrives", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const markRead = vi.fn();
  const view = renderHook((value) => useSessionRead(markRead, value, true), {
    initialProps: snapshot(),
  });
  expect(markRead).toHaveBeenCalledExactlyOnceWith({ runId: "agr_1" });
  // A failed request leaves the authoritative snapshot unchanged.
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(markRead).toHaveBeenCalledTimes(2);
  const acknowledged = snapshot();
  acknowledged.state!.session.lastReadRunId = "agr_1";
  view.rerender(acknowledged);
  await act(() => window.dispatchEvent(new Event("focus")));
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(markRead).toHaveBeenCalledTimes(2);
});
