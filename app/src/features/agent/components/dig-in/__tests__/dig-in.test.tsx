// Purpose: Exercise rendered ranges, view-local selection and persisted anchor activity.
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import type { SessionSnapshot } from "@openchart/app/lib/agent/session-store";
import { AgentThread } from "@openchart/app/features/agent/components/thread/agent-thread";
import { AgentViewProvider } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { readDigInSelection } from "@openchart/app/features/agent/components/dig-in/selection";
import { createTransport } from "@openchart/app/lib/transport/transport";

const transport = createTransport({ origin: location.origin });

const agent = vi.hoisted(() => ({
  getSession: vi.fn(),
  markSessionRead: { mutate: vi.fn() },
  commands: { data: [], isPending: false, isError: false },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent }),
}));
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, left: 100, width: 200, height: 20 }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
afterEach(() => window.getSelection()?.removeAllRanges());

function fixture(content = "Repeat **word** then word.\n\nNext line.") {
  const session = {
    id: "parent" as never,
    parentId: null,
    kind: "chat" as const,
    bindingId: null,
    anchors: null,
    title: "Parent",
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    lastReadRunId: null,
    compactingAt: null,
  };
  const snapshot: SessionSnapshot = {
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
    subagents: {},
    state: {
      session,
      runs: [],
      questions: [],
      permissions: [],
      messageInfo: {},
      history: { nextCursor: null },
    },
    messages: [
      {
        id: "part",
        role: "assistant",
        content,
        metadata: { openchart: { messageId: "message" } },
      },
    ],
  };
  let child: SessionSnapshot = {
    ...snapshot,
    messages: [],
    state: {
      ...snapshot.state!,
      session: {
        ...session,
        id: "child" as never,
        parentId: "parent" as never,
        kind: "dig_in",
      },
    },
  };
  const listeners = new Set<() => void>();
  const handles = new Map<string, object>();
  agent.getSession.mockImplementation((id: string) => {
    if (!handles.has(id))
      handles.set(id, {
        loadOlder: vi.fn(),
        getSnapshot: () => (id === "child" ? child : snapshot),
        subscribe: (fn: () => void) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        cancel: vi.fn(),
        replyQuestion: vi.fn(),
        replyPermission: vi.fn(),
      });
    return handles.get(id);
  });
  return {
    session,
    setRunning(running: boolean) {
      child = {
        ...child,
        state: {
          ...child.state!,
          runs: running ? [{ status: "running" } as never] : [],
        },
      };
      for (const fn of listeners) fn();
    },
  };
}

function select(start: HTMLElement, end = start) {
  act(() => {
    const range = document.createRange();
    range.selectNodeContents(start);
    const tail = document.createRange();
    tail.selectNodeContents(end);
    range.setEnd(tail.endContainer, tail.endOffset);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  fireEvent.mouseUp(document);
}

test("selection belongs to one view even when another mounted view shows the same Session", async () => {
  const { session } = fixture();
  const first = vi.fn();
  const second = vi.fn();
  render(
    <>
      {[first, second].map((onOpen, index) => (
        <section key={index} aria-label={`View ${index}`}>
          <AgentViewProvider
            value={{
              transport,
              session,
              model: undefined,
              pending: undefined,
              onOpen,
            }}
          >
            <AgentThread
              sessionID="parent"
              model={{
                providerID: "codex" as const,
                modelID: "tier1" as const,
              }}
              onSubmit={async () => {}}
            />
          </AgentViewProvider>
        </section>
      ))}
    </>,
  );
  const view = within(screen.getByRole("region", { name: "View 1" }));
  await waitFor(() => expect(view.getByRole("textbox")).toHaveFocus());
  select(
    view.getByText("word", { exact: true }),
    view.getByText("then word.", { exact: true }),
  );
  const action = await screen.findByRole("button", { name: "Dig in" });
  expect(screen.getAllByRole("toolbar")).toHaveLength(1);
  await userEvent.click(action);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        sessionID: "parent",
        messageID: "message",
        selection: {
          partId: "part",
          startOffset: 7,
          endOffset: 22,
          text: "word then word.",
        },
      }),
    }),
  );
});

test("restored anchors retain Markdown, open the saved child, and shimmer while that child runs", async () => {
  const { session, setRunning } = fixture();
  const onOpen = vi.fn();
  const anchored = {
    ...session,
    anchors: [
      {
        partId: "part",
        startOffset: 7,
        endOffset: 22,
        text: "word then word.",
        childSessionId: "older-child",
      },
      {
        partId: "part",
        startOffset: 7,
        endOffset: 22,
        text: "word then word.",
        childSessionId: "child",
      },
    ],
  };
  render(
    <AgentViewProvider
      value={{
        transport,
        session: anchored,
        model: undefined,
        pending: undefined,
        onOpen,
      }}
    >
      <AgentThread
        sessionID="parent"
        model={{ providerID: "codex" as const, modelID: "tier1" as const }}
        onSubmit={async () => {}}
      />
    </AgentViewProvider>,
  );
  const marks = screen.getAllByRole("button", {
    name: "Open Dig in: word then word.",
  });
  expect(marks).toHaveLength(2);
  act(() => setRunning(true));
  await waitFor(() => expect(marks[0]).toHaveAttribute("aria-busy", "true"));
  expect(marks[0]).toContainHTML('data-active="true"');
  await userEvent.click(marks[0]!);
  expect(onOpen).toHaveBeenCalledWith(
    expect.objectContaining({ childSessionID: "child" }),
  );
  act(() => setRunning(false));
  expect(marks[0]).toHaveAttribute("aria-busy", "false");
  expect(marks[0]).not.toContainHTML('data-active="true"');
  // Reselecting a saved range must reopen the same latest child as its underline.
  select(marks[0]!, marks[1]!);
  await userEvent.click(await screen.findByRole("button", { name: "Dig in" }));
  expect(onOpen).toHaveBeenLastCalledWith(
    expect.objectContaining({ childSessionID: "child" }),
  );
});

test("partial repeated words use their actual position and cross-paragraph selections retain one range", () => {
  const { session } = fixture();
  render(
    <AgentViewProvider
      value={{
        transport,
        session,
        model: undefined,
        pending: undefined,
        onOpen: vi.fn(),
      }}
    >
      <AgentThread
        sessionID="parent"
        model={{ providerID: "codex" as const, modelID: "tier1" as const }}
        onSubmit={async () => {}}
      />
    </AgentViewProvider>,
  );
  const passage = screen.getByText("then word.", { exact: true });
  const thread = screen.getByLabelText("Conversation");
  act(() => {
    const range = document.createRange();
    // Native selections address Text nodes; Testing Library has no Range API.
    // eslint-disable-next-line testing-library/no-node-access
    range.setStart(passage.firstChild!, 6);
    // eslint-disable-next-line testing-library/no-node-access
    range.setEnd(passage.firstChild!, 10);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  expect(readDigInSelection(thread)?.selection).toEqual({
    partId: "part",
    text: "word",
    startOffset: 17,
    endOffset: 21,
  });
  select(passage, screen.getByText("Next line."));
  expect(readDigInSelection(thread)?.selection).toEqual({
    partId: "part",
    text: " then word.\nNext line.",
    startOffset: 11,
    endOffset: 33,
  });
});

test("table cells stay valid Markdown and specialized code renderers cannot create invalid selections", () => {
  const { session } = fixture(
    "Before `code` after.\n\n| Heading |\n| --- |\n| Value |",
  );
  const view = render(
    <AgentViewProvider
      value={{
        transport,
        session,
        model: undefined,
        pending: undefined,
        onOpen: vi.fn(),
      }}
    >
      <AgentThread
        sessionID="parent"
        model={{ providerID: "codex" as const, modelID: "tier1" as const }}
        onSubmit={async () => {}}
      />
    </AgentViewProvider>,
  );
  const thread = screen.getByLabelText("Conversation");
  select(screen.getByText("Before"), screen.getByText("after."));
  expect(readDigInSelection(thread)).toBeUndefined();
  select(screen.getByText("Value"));
  expect(readDigInSelection(thread)?.selection.text).toBe("Value");
  expect(
    // Verify legal table structure after the Markdown transform.
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    view.container.querySelector("table > span, tbody > span, tr > span"),
  ).toBeNull();
});
