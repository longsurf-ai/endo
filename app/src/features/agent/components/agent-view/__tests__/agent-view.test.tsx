// Purpose: Verify independent conversation views share an Agent without sharing host state.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { AgentView } from "@openchart/app/features/agent/components/agent-view/agent-view";
import { BranchAction } from "@openchart/app/features/agent/components/thread/transcript/branch-action";
import { createTransport } from "@openchart/app/lib/transport/transport";
import type {
  SessionSnapshot,
  SessionStore,
} from "@openchart/app/lib/agent/session-store";

const parsedMarkdown = vi.hoisted(() => vi.fn());
vi.mock(
  "@openchart/app/features/agent/components/dig-in/rehype-dig-in-anchors",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@openchart/app/features/agent/components/dig-in/rehype-dig-in-anchors")
      >();
    return {
      ...original,
      rehypeDigInAnchors: (
        ...args: Parameters<typeof original.rehypeDigInAnchors>
      ) => {
        const transform = original.rehypeDigInAnchors(...args);
        return (
          tree: Parameters<typeof transform>[0],
          file: { value: unknown },
        ) => {
          parsedMarkdown(String(file.value));
          return transform(tree);
        };
      },
    };
  },
);

const agent = vi.hoisted(() => ({
  getSession: vi.fn(),
  markSessionRead: { mutate: vi.fn() },
  commands: { data: [], isPending: false, isError: false },
  createSession: { isPending: false },
  truncateSession: { isPending: false, isError: false, variables: undefined },
  submitPrompt: {
    error: new Error("Submission unavailable"),
    variables: {
      sessionID: "first",
      draft: {
        text: "First draft",
        quote: { text: "First quote", messageId: "message_first" },
        attachments: [],
      },
      model: { providerID: "codex", modelID: "tier1" },
    },
    isPending: true,
    isError: false,
  },
  defaultModel: { providerID: "codex", modelID: "tier1" },
  modelProviders: {
    data: [
      {
        id: "codex",
        name: "Codex",
        models: [
          { providerID: "codex", id: "tier1", tier: 1, name: "First model" },
          { providerID: "codex", id: "tier2", tier: 2, name: "Second model" },
        ],
      },
    ],
    isPending: false,
    isError: false,
  },
  providerSetup: [{ data: { status: "idle" } }, { data: { status: "idle" } }],
}));
const rpc = vi.hoisted(() => ({
  resources: {
    workspace: {
      getDefault: { query: vi.fn().mockResolvedValue("wsp_first") },
      get: {
        query: vi.fn(async ({ id }: { id: string }) => ({
          id,
          root: `/workspaces/${id}`,
        })),
      },
      list: {
        query: vi.fn().mockResolvedValue({
          items: ["wsp_first", "wsp_second", "wsp_third"].map((id) => ({
            id,
            root: `/workspaces/${id}`,
          })),
          nextCursor: null,
        }),
      },
    },
  },
  workspace: {
    listTree: {
      query: vi
        .fn()
        .mockResolvedValue({ status: "ready", directories: [], entries: [] }),
    },
  },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent }),
}));

// jsdom has no viewport scrolling implementation.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function session(id: string): ReturnType<SessionStore["getSession"]> {
  const snapshot: SessionSnapshot = {
    messages: [
      {
        id: `part_${id}`,
        role: "assistant",
        content: `${id} answer`,
        metadata: { openchart: { messageId: `message_${id}` } },
      },
    ],
    subagents: {},
    state: undefined,
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
  };
  return {
    id,
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
}

test("keeps transcripts, failed drafts, models, workspaces, submission status and actions local to each view", async () => {
  const transport = createTransport({ origin: location.origin });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const firstSession = session("first");
  const secondSession = session("second");
  agent.getSession.mockImplementation((id) =>
    id === "first" ? firstSession : secondSession,
  );
  const firstSubmit = vi.fn(async () => {});
  const secondSubmit = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(undefined);
  const firstFork = vi.fn(async () => {});
  const secondFork = vi.fn(async () => {});
  const views = () => (
    <QueryClientProvider client={client}>
      <section aria-label="First conversation">
        <AgentView
          transport={transport}
          sessionID="first"
          workspaceId="wsp_first"
          onSubmit={firstSubmit}
          messageActions={<BranchAction onFork={firstFork} pending />}
        />
      </section>
      <section aria-label="Second conversation">
        <AgentView
          transport={transport}
          sessionID="second"
          workspaceId="wsp_second"
          onSubmit={secondSubmit}
          messageActions={<BranchAction onFork={secondFork} pending={false} />}
        />
      </section>
    </QueryClientProvider>
  );
  const { rerender, unmount } = render(views());
  const first = within(
    screen.getByRole("region", { name: "First conversation" }),
  );
  const second = within(
    screen.getByRole("region", { name: "Second conversation" }),
  );
  const firstInput = first.getByRole("textbox", { name: "Message" });
  const secondInput = second.getByRole("textbox", { name: "Message" });
  expect(first.getByText("first answer")).toBeVisible();
  expect(first.queryByText("second answer")).not.toBeInTheDocument();
  expect(second.getByText("second answer")).toBeVisible();
  expect(second.queryByText("first answer")).not.toBeInTheDocument();
  expect(
    await second.findByRole("button", { name: "Workspace: wsp_second" }),
  ).toBeEnabled();
  expect(
    await first.findByRole("button", { name: "Workspace: wsp_first" }),
  ).toBeDisabled();
  expect(firstInput).toHaveAttribute("contenteditable", "false");
  expect(firstInput).toHaveTextContent(/^$/);
  expect(secondInput).toHaveAttribute("contenteditable", "true");
  expect(secondInput).toHaveTextContent(/^$/);
  expect(second.queryByText("First quote")).not.toBeInTheDocument();
  expect(
    first.getByRole("button", { name: "Branch in new chat" }),
  ).toBeDisabled();
  expect(first.getByText("First model")).toBeVisible();
  await userEvent.click(second.getByRole("combobox", { name: "First model" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "Second model Codex" }),
  );
  expect(second.getByText("Second model")).toBeVisible();
  await userEvent.click(
    second.getByRole("button", { name: "Workspace: wsp_second" }),
  );
  await userEvent.click(
    await screen.findByRole("menuitemradio", { name: "wsp_third" }),
  );
  expect(
    await second.findByRole("button", { name: "Workspace: wsp_third" }),
  ).toBeVisible();
  expect(
    first.getByRole("button", { name: "Workspace: wsp_first" }),
  ).toBeVisible();

  agent.submitPrompt.isPending = false;
  agent.submitPrompt.isError = true;
  rerender(views());
  await waitFor(() => expect(firstInput).toHaveTextContent("First draft"));
  expect(firstInput).toHaveAttribute("contenteditable", "true");
  expect(first.getByText("First quote")).toBeVisible();
  expect(secondInput).toHaveTextContent(/^$/);
  expect(second.queryByText("First quote")).not.toBeInTheDocument();

  await userEvent.click(
    second.getByRole("button", { name: "Branch in new chat" }),
  );
  expect(secondFork).toHaveBeenCalledExactlyOnceWith("message_second");
  expect(firstFork).not.toHaveBeenCalled();
  await userEvent.type(secondInput, "Second draft");
  await userEvent.click(second.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(secondInput).toHaveTextContent("Second draft"));
  await userEvent.click(second.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(secondInput).toHaveTextContent(/^$/));
  expect(secondSubmit).toHaveBeenCalledTimes(2);
  expect(secondSubmit).toHaveBeenLastCalledWith(
    "second",
    { text: "Second draft", quote: undefined, attachments: [] },
    { providerID: "codex", modelID: "tier2" },
    "wsp_third",
  );
  expect(firstSubmit).not.toHaveBeenCalled();
  expect(firstInput).toHaveTextContent("First draft");
  expect(first.getByText("First quote")).toBeVisible();
  unmount();
  client.clear();
});

test("streams new text without reparsing old Markdown and still updates model choices and anchors", async () => {
  const transport = createTransport({ origin: location.origin });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  let snapshot: SessionSnapshot = {
    messages: [
      { id: "user", role: "user", content: "Explain" },
      {
        id: "old",
        role: "assistant",
        content: "Historical **answer**.",
        metadata: { openchart: { messageId: "old_message" } },
      },
      { id: "latest_user", role: "user", content: "Continue" },
      {
        id: "live",
        role: "assistant",
        content: "New answer",
        metadata: { openchart: { messageId: "live_message" } },
      },
    ],
    subagents: {},
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
    state: {
      session: {
        id: "streaming" as never,
        parentId: null,
        kind: "chat",
        bindingId: null,
        anchors: null,
        title: "Streaming",
        createdAt: 1,
        updatedAt: 1,
        archivedAt: null,
        lastReadRunId: null,
        compactingAt: null,
      },
      runs: [
        {
          id: "agr_streaming" as never,
          sessionID: "streaming",
          sessionIntentID: "streaming-test",
          status: "running",
          queuePosition: null,
          createdAt: Date.now(),
          startedAt: Date.now(),
          finishedAt: null,
        },
      ],
      questions: [],
      permissions: [],
      history: { nextCursor: null },
      messageInfo: {
        latest_user: {
          model: { providerID: "codex", modelID: "tier1" },
          workspaceId: "wsp_first",
        },
      },
    },
  };
  const listeners = new Set<() => void>();
  const handle = {
    ...session("streaming"),
    loadOlder: vi.fn(),
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const child = session("child");
  agent.getSession.mockImplementation((id) =>
    id === "streaming" ? handle : child,
  );
  const onSubmit = vi.fn(async () => {});
  const onOpenPanel = vi.fn();
  const view = (header = "Conversation") => (
    <QueryClientProvider client={client}>
      <AgentView
        transport={transport}
        sessionID="streaming"
        onSubmit={onSubmit}
        onOpenPanel={onOpenPanel}
        header={<h2>{header}</h2>}
      />
    </QueryClientProvider>
  );
  const { rerender, unmount } = render(view());
  await screen.findByRole("button", { name: "Workspace: wsp_first" });
  expect(parsedMarkdown).toHaveBeenCalledWith("Historical **answer**.");
  parsedMarkdown.mockClear();

  // AG-UI gives every message a fresh identity, even when only the tail changes.
  for (let index = 1; index <= 20; index++) {
    await act(async () => {
      snapshot = {
        ...snapshot,
        messages: structuredClone(snapshot.messages).map((message) =>
          message.role === "assistant" && message.id === "live"
            ? { ...message, content: `New answer ${index}` }
            : message,
        ),
      };
      for (const listener of listeners) listener();
    });
    expect(await screen.findByText(`New answer ${index}`)).toBeVisible();
  }
  // Unrelated host renders must not broadcast a new view context either.
  rerender(view("Renamed conversation"));
  expect(parsedMarkdown).not.toHaveBeenCalledWith("Historical **answer**.");

  await act(async () => {
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state!,
        messageInfo: {
          latest_user: {
            model: { providerID: "codex", modelID: "tier2" },
            workspaceId: "wsp_second",
          },
        },
      },
    };
    for (const listener of listeners) listener();
  });
  expect(screen.getByText("Second model")).toBeVisible();
  expect(
    await screen.findByRole("button", { name: "Workspace: wsp_second" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("combobox", { name: "Second model" }));
  await userEvent.click(
    await screen.findByRole("option", { name: "First model Codex" }),
  );
  expect(screen.getByText("First model")).toBeVisible();

  await act(async () => {
    snapshot = {
      ...snapshot,
      state: {
        ...snapshot.state!,
        session: {
          ...snapshot.state!.session,
          anchors: [
            {
              partId: "old",
              startOffset: 0,
              endOffset: 10,
              text: "Historical",
              childSessionId: "child",
            },
          ],
        },
      },
    };
    for (const listener of listeners) listener();
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Open Dig in: Historical" }),
  );
  expect(onOpenPanel).toHaveBeenCalledWith(
    expect.objectContaining({
      childSessionID: "child",
      model: { providerID: "codex", modelID: "tier1" },
    }),
  );
  unmount();
  client.clear();
});
