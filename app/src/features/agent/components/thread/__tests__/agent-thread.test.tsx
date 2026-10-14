import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
// Purpose: Keep first-message drafts on failure and allow history without a selectable model.
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import {
  AgentNewThread,
  AgentThread,
} from "@openchart/app/features/agent/components/thread/agent-thread";
import type {
  SessionSnapshot,
  SessionStore,
} from "@openchart/app/lib/agent/session-store";

const agent = vi.hoisted(() => ({
  getSession: vi.fn(),
  markSessionRead: { mutate: vi.fn() },
  commands: { data: [], isPending: false, isError: false },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent }),
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

function permissionSession() {
  const snapshot: SessionSnapshot = {
    messages: [{ id: "question", role: "user", content: "Run echo" }],
    subagents: {},
    state: {
      session: {
        id: "parent" as NonNullable<SessionSnapshot["state"]>["session"]["id"],
        parentId: null,
        kind: "chat",
        title: "Permission test",
        bindingId: null,
        anchors: null,
        compactingAt: null,
        archivedAt: null,
        lastReadRunId: null,
        createdAt: 1,
        updatedAt: 1,
      },
      runs: [],
      messageInfo: {},
      history: { nextCursor: null },
      questions: [],
      permissions: [
        {
          id: "per_child" as NonNullable<
            SessionSnapshot["state"]
          >["permissions"][number]["id"],
          sessionID: "child",
          action: "echo",
          resources: ["permission smoke"],
          save: ["*"],
        },
      ],
    },
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
  };
  const replyPermission = vi.fn().mockResolvedValue(undefined);
  const replyQuestion = vi.fn().mockResolvedValue(undefined);
  const session: ReturnType<SessionStore["getSession"]> = {
    id: "parent",
    loadOlder: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    submit: vi.fn(),
    rename: vi.fn(),
    cancel: vi.fn(),
    replyPermission,
    replyQuestion,
    dispose: vi.fn(),
  };
  agent.getSession.mockReturnValue(session);
  return { snapshot, replyPermission, replyQuestion };
}

test.each([
  ["Deny", "reject"],
  ["Allow once", "once"],
  ["Always allow", "always"],
])(
  "replies to a visible descendant permission with %s",
  async (label, reply) => {
    const { replyPermission } = permissionSession();
    render(<AgentThread sessionID="parent" onSubmit={vi.fn()} />);
    const card = screen.getByRole("group", { name: "Permission request" });
    expect(card).toHaveAttribute("data-slot", "approval-card");
    expect(within(card).getByText("Allow echo?")).toBeVisible();
    expect(
      within(card).getByText("The agent requests your approval."),
    ).toBeVisible();
    expect(card).toHaveTextContent("permission smoke");
    expect(card).toHaveTextContent("Always allows: *");
    await userEvent.click(within(card).getByRole("button", { name: label }));
    expect(replyPermission).toHaveBeenCalledExactlyOnceWith("per_child", reply);
    // Removal belongs to the authoritative pending view, never an optimistic click.
    expect(card).toBeInTheDocument();
  },
);

test("shows request details and both approval scopes for long permission inputs", async () => {
  const { snapshot } = permissionSession();
  const resource = "provider:" + "A".repeat(240);
  snapshot.state!.permissions = [
    {
      ...snapshot.state!.permissions[0]!,
      resources: [resource],
      save: [resource],
      metadata: { query: resource },
    },
  ];

  render(<AgentThread readOnly sessionID="parent" onSubmit={vi.fn()} />);
  const card = screen.getByRole("group", { name: "Permission request" });
  expect(card).toHaveTextContent(`Request: ${resource}`);
  expect(card).toHaveTextContent(`Always allows: ${resource}`);

  await userEvent.click(within(card).getByText("Request details"));
  expect(within(card).getByText(/"query":/)).toBeVisible();
  expect(card).toHaveTextContent(resource);
});

test("omits Always allow when there is no grant to save", () => {
  const { snapshot } = permissionSession();
  snapshot.state!.permissions = [
    { ...snapshot.state!.permissions[0]!, save: [] },
  ];

  render(<AgentThread readOnly sessionID="parent" onSubmit={vi.fn()} />);
  const card = screen.getByRole("group", { name: "Permission request" });
  expect(
    within(card).queryByRole("button", { name: "Always allow" }),
  ).not.toBeInTheDocument();
});

test("shows a failed run's saved model error even when the model emitted no message", () => {
  const { snapshot } = permissionSession();
  snapshot.error = "Run failed or was interrupted; see the transcript.";
  snapshot.state!.permissions = [];
  snapshot.state!.runs = [
    {
      id: "agr_failed" as NonNullable<
        SessionSnapshot["state"]
      >["runs"][number]["id"],
      sessionID: "parent",
      sessionIntentID: "intent",
      status: "failed",
      queuePosition: null,
      createdAt: 1,
      startedAt: 2,
      finishedAt: 4,
    },
  ];
  snapshot.state!.messageInfo = {
    assistant: {
      workspaceRoot: "/test",
      completedAt: 3,
      error: {
        name: "UnknownError",
        data: { message: "Fable requires usage credits" },
      },
      finish: null,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  };
  const view = render(<AgentThread sessionID="parent" onSubmit={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Fable requires usage credits",
  );
  expect(screen.queryByText(snapshot.error)).not.toBeInTheDocument();

  // Reopening retains the saved detail without the transient RUN_ERROR event.
  snapshot.error = undefined;
  view.rerender(<AgentThread sessionID="parent" onSubmit={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Fable requires usage credits",
  );

  // A new run clears the notice even while the previous error remains in history.
  snapshot.state!.runs = [
    ...snapshot.state!.runs,
    {
      ...snapshot.state!.runs[0]!,
      id: "agr_retry" as NonNullable<
        SessionSnapshot["state"]
      >["runs"][number]["id"],
      status: "running",
      createdAt: 5,
      startedAt: 6,
      finishedAt: null,
    },
  ];
  view.rerender(<AgentThread sessionID="parent" onSubmit={vi.fn()} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("allows replies to pending questions and permissions in a read-only view", async () => {
  const { snapshot, replyQuestion, replyPermission } = permissionSession();
  snapshot.state!.questions = [
    {
      id: "que_child" as NonNullable<
        SessionSnapshot["state"]
      >["questions"][number]["id"],
      sessionID: "child",
      questions: [
        {
          id: "mode",
          header: "Mode",
          question: "Which mode?",
          options: [{ label: "Fast", description: "Quick result" }],
          multiple: false,
          allowFreeform: false,
          secret: false,
        },
      ],
    },
  ];
  render(<AgentThread sessionID="parent" readOnly onSubmit={vi.fn()} />);

  const skip = screen.getByRole("button", { name: "Skip questions" });
  const allow = screen.getByRole("button", { name: "Allow once" });
  expect(skip).toBeEnabled();
  expect(allow).toBeEnabled();
  await userEvent.click(skip);
  await userEvent.click(allow);
  expect(replyQuestion).toHaveBeenCalledExactlyOnceWith("que_child", {
    type: "skipped",
  });
  expect(replyPermission).toHaveBeenCalledExactlyOnceWith("per_child", "once");
});

test("keeps permissions visible, prevents duplicate replies, and permits retry after failure", async () => {
  const { snapshot, replyPermission } = permissionSession();
  let rejectReply!: (error: Error) => void;
  replyPermission.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectReply = reject;
      }),
  );
  const view = render(<AgentThread sessionID="parent" onSubmit={vi.fn()} />);
  const card = screen.getByRole("group", { name: "Permission request" });
  await userEvent.click(
    within(card).getByRole("button", { name: "Allow once" }),
  );
  expect(card).toHaveAttribute("aria-busy", "true");
  for (const button of within(card).getAllByRole("button"))
    expect(button).toBeDisabled();
  await userEvent.click(
    within(card).getByRole("button", { name: "Always allow" }),
  );
  expect(replyPermission).toHaveBeenCalledTimes(1);

  await act(async () => {
    rejectReply(new Error("Reply failed"));
  });
  view.rerender(<AgentThread sessionID="parent" onSubmit={vi.fn()} />);
  expect(await screen.findByText("Reply failed")).toBeInTheDocument();
  for (const button of within(card).getAllByRole("button"))
    expect(button).toBeEnabled();
  await userEvent.click(within(card).getByRole("button", { name: "Deny" }));
  expect(replyPermission).toHaveBeenLastCalledWith("per_child", "reject");

  snapshot.state!.permissions = [];
  view.rerender(<AgentThread sessionID="parent" onSubmit={vi.fn()} />);
  expect(
    screen.queryByRole("group", { name: "Permission request" }),
  ).not.toBeInTheDocument();
});

test("retains the first draft on a rejected submission and while disabled", async () => {
  const onSubmit = vi
    .fn()
    .mockRejectedValue(new Error("Connection unavailable"));
  const { rerender } = render(<AgentNewThread onSubmit={onSubmit} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  await userEvent.type(input, "Research earnings");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  rerender(<AgentNewThread onSubmit={onSubmit} />);
  await waitFor(() => expect(input).toHaveTextContent("Research earnings"));
  rerender(<AgentNewThread onSubmit={onSubmit} disabled />);
  expect(input).toHaveAttribute("contenteditable", "false");
  expect(input).toHaveTextContent("Research earnings");
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    text: "Research earnings",
    quote: undefined,
    attachments: [],
  });
});

test("renders existing history while no model is selectable", () => {
  const snapshot: SessionSnapshot = {
    messages: [{ id: "question", role: "user", content: "Earlier question" }],
    subagents: {},
    state: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
  };
  const session: ReturnType<SessionStore["getSession"]> = {
    id: "session",
    loadOlder: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    submit: vi.fn(),
    rename: vi.fn(),
    cancel: vi.fn(),
    replyQuestion: vi.fn(),
    replyPermission: vi.fn(),
    dispose: vi.fn(),
  };
  agent.getSession.mockReturnValue(session);
  render(<AgentThread sessionID="session" onSubmit={vi.fn()} />);
  expect(screen.getByText("Earlier question")).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "contenteditable",
    "false",
  );
});

test("updates computer steps inside the stable layout and preserves them outside Worked folding", async () => {
  let snapshot: SessionSnapshot = {
    messages: [{ id: "question", role: "user", content: "Inspect the screen" }],
    subagents: {},
    state: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const session: ReturnType<SessionStore["getSession"]> = {
    id: "session",
    loadOlder: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: vi.fn(),
    rename: vi.fn(),
    cancel: vi.fn(),
    replyQuestion: vi.fn(),
    replyPermission: vi.fn(),
    dispose: vi.fn(),
  };
  agent.getSession.mockReturnValue(session);
  render(<AgentThread sessionID="session" onSubmit={vi.fn()} />);
  expect(
    screen.queryByRole("region", { name: "Computer use preview" }),
  ).not.toBeInTheDocument();

  for (const id of ["first", "second"]) {
    act(() => {
      snapshot = {
        ...snapshot,
        messages: [
          ...snapshot.messages,
          {
            id: `${id}-call`,
            role: "assistant",
            toolCalls: [
              {
                id,
                type: "function",
                function: { name: "screenshot", arguments: "{}" },
              },
            ],
          },
          {
            id: `${id}-result`,
            role: "tool",
            toolCallId: id,
            content: "Captured",
          },
          {
            id,
            role: "activity",
            activityType: "openchart.tool",
            content: {
              toolCallId: id,
              status: "completed",
              attachments: [],
              details: {
                computerUse: {
                  title: "Computer use",
                  screenshot: {
                    mime: "image/png",
                    url: `https://example.com/${id}.png`,
                  },
                },
              },
            },
          },
        ],
      };
      for (const listener of listeners) listener();
    });
    const preview = screen.getByRole("region", {
      name: "Computer use preview",
    });
    expect(
      within(preview).getByRole("img", { name: "Computer screenshot" }),
    ).toHaveAttribute("src", `https://example.com/${id}.png`);
  }
  act(() => {
    snapshot = {
      ...snapshot,
      messages: [
        ...snapshot.messages,
        { id: "answer", role: "assistant", content: "Finished screenshots" },
      ],
    };
    for (const listener of listeners) listener();
  });
  const preview = screen.getByRole("region", { name: "Computer use preview" });
  expect(within(preview).getByText("2/2")).toBeVisible();
  const worked = screen.getByRole("button", { name: /^Worked/ });
  await userEvent.click(worked);
  await userEvent.click(worked);
  expect(worked).toHaveAttribute("aria-expanded", "false");
  expect(preview).toBeVisible();
  expect(within(preview).getByRole("img")).toHaveAttribute(
    "src",
    "https://example.com/second.png",
  );
});

test.each(["stop", "error"])(
  "keeps a delegate's progress dot after tools finish until its Assistant ends with %s",
  (finish) => {
    const assistant = {
      workspaceRoot: "/test",
      completedAt: null,
      error: null,
      finish: null,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
    let snapshot: SessionSnapshot = {
      messages: [
        { id: "question", role: "user", content: "Research earnings" },
        {
          id: "lookup",
          role: "assistant",
          toolCalls: [
            {
              id: "search",
              type: "function",
              function: { name: "WebSearch", arguments: "{}" },
            },
          ],
        },
        {
          id: "result",
          role: "tool",
          toolCallId: "search",
          content: "Found earnings",
        },
      ],
      subagents: {},
      state: {
        session: {
          id: "child" as NonNullable<SessionSnapshot["state"]>["session"]["id"],
          parentId: "parent" as NonNullable<
            SessionSnapshot["state"]
          >["session"]["id"],
          kind: "delegate",
          title: "Research",
          bindingId: null,
          anchors: null,
          compactingAt: null,
          archivedAt: null,
          lastReadRunId: null,
          createdAt: 1,
          updatedAt: 1,
        },
        runs: [],
        questions: [],
        permissions: [],
        messageInfo: { assistant },
        history: { nextCursor: null },
      },
      history: { hasMore: false, loading: false, error: undefined },
      loading: false,
      error: undefined,
    };
    const session: ReturnType<SessionStore["getSession"]> = {
      id: "child",
      loadOlder: vi.fn(),
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      submit: vi.fn(),
      rename: vi.fn(),
      cancel: vi.fn(),
      replyQuestion: vi.fn(),
      replyPermission: vi.fn(),
      dispose: vi.fn(),
    };
    agent.getSession.mockReturnValue(session);
    const view = render(
      <AgentThread sessionID="child" readOnly onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole("status", { name: "Working" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state!,
        messageInfo: { assistant: { ...assistant, completedAt: 2, finish } },
      },
    };
    view.rerender(
      <AgentThread sessionID="child" readOnly onSubmit={vi.fn()} />,
    );
    expect(
      screen.queryByRole("status", { name: "Working" }),
    ).not.toBeInTheDocument();
  },
);
