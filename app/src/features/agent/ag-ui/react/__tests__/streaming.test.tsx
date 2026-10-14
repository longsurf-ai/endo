// Purpose: Exercise real adapter/primitives against cloned histories and token updates.
import { useAui, useAuiState } from "@assistant-ui/react";
import { act, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Message } from "@ag-ui/core";
import type {
  SessionSnapshot,
  SessionStore,
} from "@openchart/app/lib/agent/session-store";
import { AgentThread } from "@openchart/app/features/agent/components/thread/agent-thread";

const renders = vi.hoisted(() => new Map<string, number>());
const agent = vi.hoisted(() => ({
  getSession: vi.fn(),
  markSessionRead: { mutate: vi.fn() },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent }),
}));
vi.mock(
  "@openchart/app/features/agent/components/thread/agent-layout/agent-layout",
  async (original) => {
    const module =
      await original<
        typeof import("@openchart/app/features/agent/components/thread/agent-layout/agent-layout")
      >();
    return {
      ...module,
      AgentLayout: (props: ComponentProps<typeof module.AgentLayout>) => {
        renders.set("layout", (renders.get("layout") ?? 0) + 1);
        return <module.AgentLayout {...props} />;
      },
    };
  },
);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
vi.mock(
  "@openchart/app/features/agent/components/thread/transcript/markdown/markdown-text",
  async (original) => {
    const module =
      await original<
        typeof import("@openchart/app/features/agent/components/thread/transcript/markdown/markdown-text")
      >();
    return {
      ...module,
      MarkdownText: () => {
        const id = useAuiState((s) => s.message.id);
        renders.set(id, (renders.get(id) ?? 0) + 1);
        return <module.MarkdownText />;
      },
    };
  },
);

function harness(messages: Message[]) {
  let snapshot: SessionSnapshot = {
    messages,
    state: undefined,
    subagents: {},
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const session: ReturnType<SessionStore["getSession"]> = {
    id: "streaming",
    loadOlder: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit: vi.fn(),
    rename: vi.fn(),
    cancel: vi.fn(),
    replyQuestion: vi.fn(),
    replyPermission: vi.fn(),
    dispose: vi.fn(),
  };
  agent.getSession.mockReturnValue(session);
  let aui: ReturnType<typeof useAui>;
  function RuntimeProbe() {
    aui = useAui();
    return null;
  }
  render(
    <AgentThread sessionID={session.id} readOnly onSubmit={async () => {}}>
      <RuntimeProbe />
    </AgentThread>,
  );
  return {
    getMessages: () => aui.thread().getState().messages,
    publish: async (next: Message[]) => {
      await act(async () => {
        snapshot = { ...snapshot, messages: structuredClone(next) };
        for (const listener of listeners) listener();
      });
    },
  };
}

test("new tokens retain historical runtime messages, dates and Markdown renders across cloned snapshots", async () => {
  const messages: Message[] = Array.from({ length: 40 }, (_, index) => [
    {
      id: `user-${index}`,
      role: "user" as const,
      content: `Question ${index}`,
    },
    {
      id: `answer-${index}`,
      role: "assistant" as const,
      content: `**Answer ${index}**`,
      ...(index % 2
        ? { metadata: { openchart: { createdAt: 1234 + index } } }
        : {}),
    },
  ]).flat();
  messages.push({ id: "current-user", role: "user", content: "Continue" });
  const current = {
    id: "current",
    role: "assistant",
    content: "First",
  } satisfies Message;
  messages.push(current);
  const view = harness(messages);
  const history = view.getMessages().slice(0, -1);
  renders.clear();
  for (let index = 0; index < 20; index++) {
    current.content += " next";
    await view.publish(messages);
    history.forEach((message, offset) =>
      expect(view.getMessages()[offset]).toBe(message),
    );
  }
  expect(history[3]?.createdAt.getTime()).toBe(1235);
  expect([...renders.keys()].filter((id) => id !== "current")).toEqual([]);
  expect(renders.get("current")).toBeGreaterThan(0);
  expect(await screen.findByText(current.content)).toBeVisible();

  // Authoritative replacement may edit or remove history; sharing must not freeze it.
  messages[1] = {
    ...messages[1]!,
    content: "Corrected historical answer",
  } as Message;
  await view.publish(messages.slice(0, -2));
  expect(await screen.findByText("Corrected historical answer")).toBeVisible();
  expect(screen.queryByText(current.content)).not.toBeInTheDocument();
  expect(view.getMessages()[1]).not.toBe(history[1]);
});

test("late tool results and Activity changes invalidate their owner without refreshing other turns", async () => {
  const messages: Message[] = [
    { id: "user", role: "user", content: "Search" },
    {
      id: "tool",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "search", arguments: "{}" },
        },
      ],
    },
    { id: "result", role: "tool", toolCallId: "call", content: "old" },
    {
      id: "activity",
      role: "activity",
      activityType: "openchart.tool",
      content: { toolCallId: "call", status: "running" },
    },
    { id: "next", role: "user", content: "Next question" },
    { id: "answer", role: "assistant", content: "Unaffected answer" },
  ];
  const view = harness(messages);
  const unchanged = view.getMessages().at(-1);
  const result = messages[2]!;
  if (result.role !== "tool") throw new Error("Expected tool fixture");
  result.content = "updated";
  result.error = "Failed";
  const activity = messages[3]!;
  if (activity.role !== "activity")
    throw new Error("Expected Activity fixture");
  activity.content = {
    toolCallId: "call",
    status: "error",
    details: { reason: "Updated failure" },
  };
  await view.publish(messages);
  expect(view.getMessages()[1]).toMatchObject({
    content: [{ result: "updated", isError: true }],
    metadata: {
      custom: {
        toolActivities: {
          call: { status: "error", details: { reason: "Updated failure" } },
        },
      },
    },
  });
  expect(view.getMessages().at(-1)).toBe(unchanged);
});
