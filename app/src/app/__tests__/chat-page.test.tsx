import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
import { findErrorToast, testAppHost } from "@openchart/app/testing/test-utils";
import { createQueryClient } from "@openchart/app/lib/react-query/react-query";
// Purpose: Verify navigation and chat switching through the shared app shell.

import {
  CLAUDE_CODE,
  CODEX,
  TIER1,
  TIER2,
} from "@openchart/models/model-tiers";

import {
  EventType,
  type Message,
  type SubagentStartedEvent,
} from "@ag-ui/core";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { AppRouter } from "@openchart/app/app/router";
import { AppHostProvider } from "@openchart/app/lib/host/host";
import type { SessionState } from "@openchart/app/lib/agent/client";
import { useSidebarSort } from "@openchart/app/stores/sidebar";
import { useAgent } from "@openchart/app/lib/agent/use-agent";
import { useSessionSnapshot } from "@openchart/app/lib/agent/use-session-snapshot";
import type { PromptParts } from "@openchart/app/lib/prompt-converter/converter";
import {
  createTransport,
  type AppEventFrame,
} from "@openchart/app/lib/transport/transport";
import { workspaceQueryKeys } from "@openchart/app/lib/workspace/workspace";

const rpc = vi.hoisted(() => ({
  events: { subscribe: { subscribe: vi.fn() } },
  proactive: { promptSuggestions: { query: vi.fn().mockResolvedValue([]) } },
  resources: {
    agent_schedule: { list: { query: vi.fn() }, patch: { mutate: vi.fn() } },
    agent_schedule_occurrence: { list: { query: vi.fn() } },
    workspace: {
      list: { query: vi.fn() },
      getDefault: { query: vi.fn().mockResolvedValue("wsp_default") },
      get: {
        query: vi.fn().mockImplementation(async ({ id }: { id: string }) => ({
          id,
          root: `/workspaces/${id}`,
        })),
      },
    },
  },
  models: {
    list: { query: vi.fn() },
    discover: {
      query: vi.fn().mockResolvedValue({
        status: "not_installed",
      }),
    },
    setupState: { query: vi.fn().mockResolvedValue({ status: "idle" }) },
  },
  config: { get: { query: vi.fn() }, update: { mutate: vi.fn() } },
  workspace: {
    listDirectory: { query: vi.fn() },
    watch: { subscribe: vi.fn() },
    listTree: {
      query: vi
        .fn()
        .mockResolvedValue({ status: "ready", directories: [], entries: [] }),
    },
    read: { query: vi.fn() },
  },
  agent: {
    markSessionRead: { mutate: vi.fn() },
    listSessions: { query: vi.fn() },
    commands: { query: vi.fn() },
    buildCommand: { mutate: vi.fn() },
    createSession: { mutate: vi.fn() },
    renameSession: { mutate: vi.fn() },
    archiveSession: { mutate: vi.fn() },
    forkSession: { mutate: vi.fn() },
    truncateSession: { mutate: vi.fn() },
    digInSession: { mutate: vi.fn() },
    cancel: { mutate: vi.fn() },
    requestSnapshot: { mutate: vi.fn() },
    prompt: { mutate: vi.fn() },
  },
}));
vi.mock("@trpc/client", async (original) => ({
  ...(await original<typeof import("@trpc/client")>()),
  createTRPCClient: () => rpc,
}));

const disposals: Array<() => void> = [];
beforeAll(async () => {
  // Compile the lazy routes before the workflow's one-second UI waits.
  await import("@openchart/app/app/workspace/workspace-page");
  await import("@openchart/app/app/schedule/schedule-page");
  // jsdom has no scrolling implementation; keep the actual viewport mounted.
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: 100, left: 100, width: 200, height: 20 }),
  });
  // Base UI forwards radio clicks through PointerEvent, which jsdom omits.
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: MouseEvent,
  });
});
afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  Reflect.deleteProperty(window, "PointerEvent");
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const dispose of disposals.splice(0)) dispose();
  window.history.replaceState({}, "", "/app");
  vi.clearAllMocks();
});

function backend() {
  rpc.workspace.watch.subscribe.mockReturnValue({ unsubscribe: vi.fn() });
  rpc.workspace.listDirectory.query.mockImplementation(async (input) => {
    const snapshot = await rpc.workspace.listTree.query(input);
    return {
      ...snapshot,
      entries: snapshot.entries.filter(
        ({ path }: { path: string }) =>
          path.split("/").slice(0, -1).join("/") === input.path,
      ),
      directories: snapshot.directories.filter(
        (path: string) => path.split("/").slice(0, -1).join("/") === input.path,
      ),
    };
  });
  useSidebarSort.setState({ chats: "updatedAt" });
  rpc.resources.agent_schedule.list.query.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  rpc.resources.agent_schedule_occurrence.list.query.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  rpc.resources.workspace.getDefault.query.mockResolvedValue("wsp_default");
  rpc.resources.workspace.get.query.mockImplementation(
    async ({ id }: { id: string }) => ({
      id,
      root: `/workspaces/${id}`,
    }),
  );
  rpc.resources.workspace.list.query.mockResolvedValue({
    items: [
      { id: "wsp_default", root: "/workspaces/wsp_default" },
      { id: "wsp_research", root: "/workspaces/wsp_research" },
    ],
    nextCursor: null,
  });
  rpc.workspace.listTree.query.mockResolvedValue({
    status: "ready",
    directories: [],
    entries: [],
  });
  let settings = {
    appearance: { theme: "system" },
    models: {
      providers: {
        [CODEX]: { enabled: true },
        [CLAUDE_CODE]: { enabled: true },
      },
    },
  };
  rpc.config.get.query.mockImplementation(async () => settings);
  rpc.config.update.mutate.mockImplementation(async (patch) => {
    settings = { ...settings, ...patch };
  });
  const sessions: SessionState["session"][] = [];
  const messages = new Map<string, Message[]>();
  const subagentEvents = new Map<string, SubagentStartedEvent[]>();
  const messageInfo = new Map<string, SessionState["messageInfo"]>();
  const listeners = new Set<(frame: AppEventFrame) => void>();
  const emit = (type: string, data: unknown) => {
    for (const next of listeners)
      next({ kind: "event", event: { id: "evt_test" as never, type, data } });
  };
  rpc.events.subscribe.subscribe.mockImplementation((_input, callbacks) => {
    listeners.add(callbacks.onData);
    queueMicrotask(() => {
      if (listeners.has(callbacks.onData)) callbacks.onData({ kind: "ready" });
    });
    return { unsubscribe: () => listeners.delete(callbacks.onData) };
  });
  rpc.agent.listSessions.query.mockImplementation(
    async ({ limit = 15, cursor, orderBy = "updatedAt" }) => {
      const roots = sessions
        .filter(
          (session) => session.parentId === null && session.archivedAt === null,
        )
        .sort(
          (a, b) =>
            b[orderBy as "createdAt" | "updatedAt"] -
              a[orderBy as "createdAt" | "updatedAt"] ||
            b.id.localeCompare(a.id),
        );
      const offset = Number(cursor ?? 0);
      return {
        items: roots
          .slice(offset, offset + limit)
          .map((session) => ({ ...session, isUnread: false, isActive: false })),
        nextCursor:
          offset + limit < roots.length ? String(offset + limit) : null,
      };
    },
  );
  rpc.agent.buildCommand.mutate.mockReset();
  rpc.agent.commands.query.mockResolvedValue([
    {
      name: "compact",
      type: "compaction",
      description: "Free up context",
      hints: [],
    },
    {
      name: "best-of-n",
      type: "workflow",
      description: "Research independently",
      hints: ["$1", "$2"],
    },
  ]);
  rpc.models.list.query.mockResolvedValue([
    {
      id: CODEX,
      name: "Codex",
      models: [
        {
          id: TIER1,
          tier: 1,
          providerID: CODEX,
          name: "Test model",
          availableVariants: [],
        },
        {
          id: TIER2,
          tier: 2,
          providerID: CODEX,
          name: "Other model",
          availableVariants: ["high", "low"],
        },
      ],
    },
  ]);
  rpc.agent.createSession.mutate.mockImplementation(async () => {
    const session: SessionState["session"] = {
      id: `ses_${sessions.length + 1}` as SessionState["session"]["id"],
      title: `Chat ${sessions.length + 1}`,
      parentId: null,
      kind: "chat",
      bindingId: null,
      anchors: null,
      compactingAt: null,
      archivedAt: null,
      lastReadRunId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    sessions.push(session);
    emit("agent.event", {
      sessionID: session.id,
      event: {
        type: "STATE_DELTA",
        delta: [{ op: "add", path: "/session", value: session }],
      },
    });
    return session;
  });
  rpc.agent.prompt.mutate.mockImplementation(async ({ sessionID, input }) => {
    messageInfo.set(sessionID, {
      msg_question: { model: input.model, workspaceId: input.workspaceId },
    });
    const target = sessions.find((session) => session.id === sessionID)!;
    const anchor = sessions
      .find((session) => session.id === target.parentId)
      ?.anchors?.find((item) => item.childSessionId === sessionID);
    const parts =
      anchor && !messages.get(sessionID)?.length
        ? [
            {
              type: "context",
              context: {
                kind: "dig_in",
                quoteText: anchor.text,
                parentSessionId: target.parentId,
              },
            },
            ...input.parts,
          ]
        : input.parts;
    messages.set(sessionID, [
      parts.some((part: { type: string }) => part.type === "context")
        ? {
            id: "msg_question",
            role: "user",
            // Bubble text only; quotes and Dig In markers render from metadata.parts.
            content: parts
              .filter((part: { type: string }) => part.type === "text")
              .map((part: { text?: string }) => part.text)
              .join("\n"),
            metadata: { parts },
          }
        : { id: "msg_question", role: "user", content: input.parts[0].text },
      {
        id: "msg_answer",
        role: "assistant",
        content: "Saved answer from the backend.",
        metadata: { openchart: { messageId: "msg_source_answer" } },
      },
    ]);
    emit("agent.event", {
      sessionID,
      event: { type: "MESSAGES_SNAPSHOT", messages: messages.get(sessionID) },
    });
    emit("agent.event", {
      sessionID,
      event: {
        type: "STATE_DELTA",
        delta: [
          {
            op: "add",
            path: "/messageInfo",
            value: messageInfo.get(sessionID),
          },
          { op: "add", path: "/history", value: { nextCursor: null } },
        ],
      },
    });
    return { id: "agr_test", sessionID, status: "completed" };
  });
  rpc.agent.truncateSession.mutate.mockImplementation(
    async ({ sessionID, messageID }) => {
      const history = messages.get(sessionID) ?? [];
      const index =
        messageID === null
          ? -1
          : history.findIndex(
              (message) => message.metadata?.openchart?.messageId === messageID,
            );
      messages.set(sessionID, history.slice(0, index + 1));
      emit("agent.event", {
        sessionID,
        event: { type: "MESSAGES_SNAPSHOT", messages: messages.get(sessionID) },
      });
      emit("agent.event", {
        sessionID,
        event: {
          type: "STATE_DELTA",
          delta: [
            { op: "add", path: "/messageInfo", value: {} },
            { op: "add", path: "/history", value: { nextCursor: null } },
          ],
        },
      });
    },
  );
  rpc.agent.forkSession.mutate.mockImplementation(async ({ sessionID }) => {
    const source = sessions.find((session) => session.id === sessionID)!;
    const branch = {
      ...source,
      id: `ses_${sessions.length + 1}` as typeof source.id,
      title: `Branch of ${source.title}`,
    };
    sessions.push(branch);
    messages.set(branch.id, structuredClone(messages.get(sessionID) ?? []));
    messageInfo.set(
      branch.id,
      structuredClone(messageInfo.get(sessionID) ?? {}),
    );
    return branch;
  });
  rpc.agent.digInSession.mutate.mockImplementation(async (input) => {
    const parent = sessions.find((session) => session.id === input.sessionID)!;
    const child: SessionState["session"] = {
      ...parent,
      id: `ses_${sessions.length + 1}` as typeof parent.id,
      parentId: parent.id,
      kind: "dig_in",
      title: `Dig in: ${input.selection.text}`,
      anchors: null,
    };
    sessions.push(child);
    parent.anchors = [
      ...(parent.anchors ?? []),
      {
        ...input.selection,
        childSessionId: child.id,
      },
    ];
    emit("agent.event", {
      sessionID: parent.id,
      event: {
        type: "STATE_DELTA",
        delta: [{ op: "add", path: "/session", value: parent }],
      },
    });
    return child;
  });
  // Deliberately omit SSE to verify the command also refreshes the directory.
  rpc.agent.renameSession.mutate.mockImplementation(
    async ({ sessionID, title }) => {
      const session = sessions.find((session) => session.id === sessionID)!;
      session.title = title;
      return { ...session };
    },
  );
  rpc.agent.archiveSession.mutate.mockImplementation(async ({ sessionID }) => {
    const session = sessions.find((session) => session.id === sessionID)!;
    session.archivedAt = Date.now();
    return { ...session };
  });
  rpc.agent.requestSnapshot.mutate.mockImplementation(async ({ sessionID }) => {
    await Promise.resolve();
    emit("agent.snapshot", {
      sessionID,
      events: [
        { type: "MESSAGES_SNAPSHOT", messages: messages.get(sessionID) ?? [] },
        ...(subagentEvents.get(sessionID) ?? []),
        {
          type: "STATE_SNAPSHOT",
          snapshot: {
            session: sessions.find((session) => session.id === sessionID),
            runs: [],
            questions: [],
            permissions: [],
            messageInfo: messageInfo.get(sessionID) ?? {},
            history: { nextCursor: null },
          },
        },
      ],
    });
  });
  return {
    sessions,
    messages,
    messageInfo,
    subagentEvents,
    listeners,
    emit,
  };
}

const appHost = testAppHost();

function renderWorkspace() {
  const queryClient = createQueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  disposals.push(() => queryClient.clear());
  return render(
    <QueryClientProvider client={queryClient}>
      <AppHostProvider value={appHost}>
        <AppRouter connection={{ origin: location.origin }} />
      </AppHostProvider>
    </QueryClientProvider>,
  );
}

test("Schedule history selects the existing Copilot Session and allows follow-up messages", async () => {
  const fixture = backend();
  const session = await rpc.agent.createSession.mutate({});
  fixture.messages.set(session.id, [
    {
      id: "schedule-question",
      role: "user",
      content: "Prepare the morning briefing.",
    },
    {
      id: "schedule-answer",
      role: "assistant",
      content: "The scheduled briefing is ready.",
    },
  ]);
  rpc.agent.createSession.mutate.mockClear();
  rpc.resources.agent_schedule.list.query.mockResolvedValue({
    items: [
      {
        id: "ags_daily",
        revision: 1,
        name: "Morning briefing",
        enabled: true,
        recurrence: {
          kind: "cron",
          expression: "0 9 * * 1-5",
          timeZone: "America/New_York",
        },
        nextFireAt: Date.parse("2026-09-21T13:00:00.000Z"),
      },
    ],
    nextCursor: null,
  });
  rpc.resources.agent_schedule_occurrence.list.query.mockResolvedValue({
    items: [
      {
        id: "aso_daily",
        scheduleId: "ags_daily",
        agentRunId: "run_daily",
        sessionId: session.id,
        fireAt: Date.parse("2026-09-18T13:00:00.000Z"),
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    nextCursor: null,
  });
  window.history.replaceState({}, "", "/app/schedule");
  renderWorkspace();
  await act(() => vi.dynamicImportSettled());
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Morning briefing" }),
  );
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();
  const transcript = await within(
    screen.getByRole("list", { name: "Runs for Morning briefing" }),
  ).findByRole("button");
  await user.click(transcript);
  const panel = within(screen.getByRole("complementary", { name: "Copilot" }));
  expect(
    await panel.findByText("The scheduled briefing is ready."),
  ).toBeVisible();
  const input = panel.getByRole("textbox", { name: "Message" });
  expect(input).toHaveAttribute("contenteditable", "true");
  expect(
    screen.getAllByRole("complementary", { name: "Copilot" }),
  ).toHaveLength(1);
  expect(
    panel.getByRole("button", { name: "Select conversation" }),
  ).toHaveTextContent(session.title);
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.requestSnapshot.mutate).toHaveBeenCalledWith({
    sessionID: session.id,
  });
  act(() =>
    fixture.emit("agent.event", {
      sessionID: session.id,
      event: {
        type: "MESSAGES_SNAPSHOT",
        messages: [
          {
            id: "schedule-update",
            role: "assistant",
            content: "The briefing has a live update.",
          },
        ],
      },
    }),
  );
  expect(
    await panel.findByText("The briefing has a live update."),
  ).toBeVisible();
  act(() =>
    fixture.emit("agent.event", {
      sessionID: session.id,
      event: {
        type: "STATE_DELTA",
        delta: [{ op: "add", path: "/history", value: { nextCursor: null } }],
      },
    }),
  );
  await user.type(input, "Explain the briefing.");
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await panel.findByText("Saved answer from the backend.");
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionID: session.id }),
  );
  expect(window.location.pathname).toBe("/app/schedule");
  await user.click(panel.getByRole("button", { name: "Close Copilot" }));
  expect(
    screen.queryByRole("complementary", { name: "Copilot" }),
  ).not.toBeInTheDocument();
  expect(transcript).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Morning briefing" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.resources.agent_schedule.patch.mutate).not.toHaveBeenCalled();
});

test("Copilot switches assistant-ui threads locally and preserves its draft when hidden", async () => {
  const fixture = backend();
  window.history.replaceState({}, "", "/app/schedule");
  renderWorkspace();
  const user = userEvent.setup();
  const toggle = await screen.findByRole("button", { name: "Toggle Copilot" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("complementary", { name: "Copilot" }),
  ).not.toBeInTheDocument();
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();

  await user.click(toggle);
  const panel = within(screen.getByRole("complementary", { name: "Copilot" }));
  expect(
    panel.getByRole("button", { name: "Select conversation" }),
  ).toHaveFocus();
  const input = panel.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "Research earnings");
  await user.click(toggle);
  expect(
    screen.queryByRole("complementary", { name: "Copilot" }),
  ).not.toBeInTheDocument();
  await user.click(toggle);
  expect(panel.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Research earnings",
  );
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await panel.findByText("Saved answer from the backend.");
  expect(
    panel.getByRole("button", { name: "Select conversation" }),
  ).toHaveTextContent("Chat 1");
  expect(window.location.pathname).toBe("/app/schedule");
  expect(window.location.search).toBe("");

  await user.click(panel.getByRole("button", { name: "Select conversation" }));
  await user.click(await screen.findByRole("menuitem", { name: "New chat" }));
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(1);
  expect(
    panel.queryByText("Saved answer from the backend."),
  ).not.toBeInTheDocument();
  await user.type(
    panel.getByRole("textbox", { name: "Message" }),
    "Second conversation",
  );
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await panel.findByText("Saved answer from the backend.");
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionID: "ses_2" }),
  );

  const beforeSwitch = rpc.agent.requestSnapshot.mutate.mock.calls.length;
  await user.click(panel.getByRole("button", { name: "Select conversation" }));
  await user.click(await screen.findByRole("menuitem", { name: "Chat 1" }));
  await panel.findByText("Research earnings");
  expect(panel.queryByText("Second conversation")).not.toBeInTheDocument();
  expect(rpc.agent.requestSnapshot.mutate.mock.calls.length).toBeGreaterThan(
    beforeSwitch,
  );
  expect(rpc.agent.requestSnapshot.mutate).toHaveBeenLastCalledWith({
    sessionID: "ses_1",
  });
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(2);
  expect(window.location.pathname).toBe("/app/schedule");
  expect(window.location.search).toBe("");
  expect(fixture.listeners.size).toBe(1);
  await user.click(panel.getByRole("button", { name: "Close Copilot" }));
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
  expect(rpc.agent.cancel.mutate).not.toHaveBeenCalled();
});

test.each(["page", "copilot"] as const)(
  "%s TaskCards hide input, retain Dig In, stream updates, and preserve the parent draft",
  async (host) => {
    const fixture = backend();
    const parent = await rpc.agent.createSession.mutate({});
    const child = await rpc.agent.createSession.mutate({});
    const grandchild = await rpc.agent.createSession.mutate({});
    Object.assign(child, {
      parentId: parent.id,
      kind: "delegate",
      title: "Research",
    });
    Object.assign(grandchild, {
      parentId: child.id,
      kind: "delegate",
      title: "Verify",
    });
    for (const [source, target] of [
      [parent, child],
      [child, grandchild],
    ]) {
      // Invocation and Session IDs deliberately differ: Activity owns the link.
      fixture.messages.set(source.id, [
        {
          id: `${source.id}-input`,
          role: "user",
          content: `${source.title} instructions`,
        },
        {
          id: `${source.id}-tools`,
          role: "assistant",
          toolCalls: [
            {
              id: `${source.id}-call`,
              type: "function",
              function: { name: "Agent", arguments: "{}" },
            },
          ],
        },
        {
          id: `${source.id}-activity`,
          role: "activity",
          activityType: "openchart.tool",
          content: {
            toolCallId: `${source.id}-call`,
            status: "running",
            childSessionId: target.id,
          },
        },
      ]);
      fixture.subagentEvents.set(source.id, [
        {
          type: EventType.SUBAGENT_STARTED,
          subagentRunId: `${source.id}-invocation`,
          name: target.title,
          parentToolCallId: `${source.id}-call`,
          parentMessageId: `${source.id}-tools`,
        },
      ]);
    }
    fixture.messages.set(grandchild.id, [
      {
        id: "verification",
        role: "assistant",
        content: "Verified child result",
        metadata: { openchart: { messageId: "msg_verification" } },
      },
    ]);
    rpc.agent.createSession.mutate.mockClear();
    window.history.replaceState(
      {},
      "",
      host === "page" ? "/app/sessions/ses_1" : "/app/settings/interface",
    );
    const view = renderWorkspace();
    const user = userEvent.setup();
    if (host === "copilot") {
      await user.click(
        await screen.findByRole("button", { name: "Toggle Copilot" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Select conversation" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Chat 1" }));
    }
    const task = await screen.findByRole("group", {
      name: "Subagent: Research",
    });
    const parentInput = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() =>
      expect(parentInput).toHaveAttribute("contenteditable", "true"),
    );
    await user.type(parentInput, "Parent draft");
    expect(parentInput).toHaveTextContent("Parent draft");
    await user.click(screen.getByRole("combobox", { name: /^Test model/ }));
    await user.click(
      await screen.findByRole("option", { name: "Other model Codex" }),
    );
    // Native button activation works with the keyboard and does not disclose inline content.
    const button = within(task).getByRole("button");
    expect(button).not.toHaveAttribute("aria-expanded");
    button.focus();
    await user.keyboard("{Enter}");
    const panelLabel = host === "page" ? "Conversation panel" : "Copilot";
    const panelElement = screen.getByRole("complementary", {
      name: panelLabel,
    });
    const panel = within(panelElement);
    expect(await panel.findByText("Research instructions")).toBeVisible();
    const resizeHandle = panel.getByRole("button", {
      name: `Resize ${panelLabel}`,
    });
    Object.assign(resizeHandle, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    });
    vi.spyOn(panelElement, "getBoundingClientRect").mockImplementation(
      () => ({ width: Number.parseFloat(panelElement.style.width) }) as DOMRect,
    );
    fireEvent.pointerDown(resizeHandle, { button: 0, clientX: 600 });
    fireEvent.pointerMove(resizeHandle, { clientX: 500 });
    fireEvent.pointerUp(resizeHandle, { clientX: 500 });
    expect(panelElement).toHaveStyle({ width: "500px" });
    resizeHandle.focus();
    await user.keyboard("{ArrowRight}");
    expect(panelElement).toHaveStyle({ width: "468px" });
    expect(rpc.agent.requestSnapshot.mutate).toHaveBeenLastCalledWith({
      sessionID: child.id,
    });
    expect(
      panel.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    expect(panel.queryByRole("combobox")).not.toBeInTheDocument();
    act(() => {
      for (const event of [
        {
          type: "TEXT_MESSAGE_START",
          messageId: "child-live",
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "child-live",
          delta: "Live child update",
        },
        { type: "TEXT_MESSAGE_END", messageId: "child-live" },
      ])
        fixture.emit("agent.event", { sessionID: child.id, event });
    });
    expect(await panel.findByText("Live child update")).toBeVisible();
    await user.click(
      within(panel.getByRole("group", { name: "Subagent: Verify" })).getByRole(
        "button",
      ),
    );
    expect(await panel.findByText("Verified child result")).toBeVisible();
    expect(panelElement).toHaveStyle({ width: "468px" });
    expect(rpc.agent.requestSnapshot.mutate).toHaveBeenLastCalledWith({
      sessionID: grandchild.id,
    });
    expect(
      panel.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    selectPassage(panel.getByText("Verified child result"));
    const selection = within(
      await screen.findByRole("toolbar", { name: "Selected text actions" }),
    );
    expect(
      selection.queryByRole("button", { name: "Quote" }),
    ).not.toBeInTheDocument();
    const digInAction = selection.getByRole("button", { name: "Dig in" });
    expect(digInAction).toBeEnabled();
    await user.click(digInAction);
    const digIn = within(screen.getByRole("region", { name: "Dig in" }));
    const digInInput = digIn.getByRole("textbox", { name: "Message" });
    expect(digInInput).toHaveAttribute("contenteditable", "true");
    await user.type(digInInput, "Explain this result");
    expect(digInInput).toHaveTextContent("Explain this result");
    await user.click(digIn.getByRole("button", { name: "Back" }));
    expect(
      panel.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    await user.click(panel.getByRole("button", { name: "Back" }));
    expect(
      panel.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    expect(panel.getByText("Live child update")).toBeVisible();
    await user.click(panel.getByRole("button", { name: "Back" }));
    expect(parentInput).toHaveTextContent("Parent draft");
    await waitFor(() => expect(parentInput).toHaveFocus());
    expect(
      screen.getByRole("combobox", { name: /^Other model/ }),
    ).toBeVisible();
    expect(window.location.pathname).toBe(
      host === "page" ? "/app/sessions/ses_1" : "/app/settings/interface",
    );
    // A cold snapshot must restore the same child link after leaving the host.
    view.unmount();
    window.history.replaceState({}, "", "/app/sessions/ses_1");
    renderWorkspace();
    await user.click(
      within(
        await screen.findByRole("group", { name: "Subagent: Research" }),
      ).getByRole("button"),
    );
    expect(await screen.findByText("Research instructions")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(
      screen.queryByRole("complementary", { name: "Conversation panel" }),
    ).not.toBeInTheDocument();
    expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
    expect(rpc.agent.digInSession.mutate).not.toHaveBeenCalled();
    expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
    expect(rpc.agent.cancel.mutate).not.toHaveBeenCalled();
  },
);

function selectPassage(element: HTMLElement) {
  act(() => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  fireEvent.mouseUp(document);
}

test.each(["page", "copilot"] as const)(
  "%s Dig In keeps selection local until Send, retries in one child, and reopens its saved anchor",
  async (host) => {
    const fixture = backend();
    rpc.workspace.listTree.query.mockResolvedValue({
      status: "ready",
      directories: [],
      entries: [{ path: "nested.tea", hash: "a".repeat(64) }],
    });
    await rpc.agent.createSession.mutate({});
    await rpc.agent.prompt.mutate({
      sessionID: "ses_1",
      input: {
        parts: [{ type: "text", text: "Parent question" }],
        model: { providerID: CODEX, modelID: TIER1 },
      },
    });
    rpc.agent.createSession.mutate.mockClear();
    rpc.agent.prompt.mutate.mockClear();
    window.history.replaceState(
      {},
      "",
      host === "page" ? "/app/sessions/ses_1" : "/app/settings/interface",
    );
    const view = renderWorkspace();
    const user = userEvent.setup();
    if (host === "copilot") {
      await user.click(
        await screen.findByRole("button", { name: "Toggle Copilot" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Select conversation" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Chat 1" }));
    }
    await screen.findByText("Saved answer from the backend.");
    const rootInput = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() =>
      expect(rootInput).toHaveAttribute("contenteditable", "true"),
    );
    await user.type(rootInput, "Parent draft");
    expect(rootInput).toHaveTextContent("Parent draft");
    await user.click(screen.getByRole("combobox", { name: /^Test model/ }));
    await user.click(
      await screen.findByRole("option", { name: "Other model Codex" }),
    );
    selectPassage(screen.getByText("Saved answer from the backend."));
    await user.click(await screen.findByRole("button", { name: "Dig in" }));
    let child = within(screen.getByRole("region", { name: "Dig in" }));
    await waitFor(() =>
      expect(child.getByRole("textbox", { name: "Message" })).toHaveFocus(),
    );
    expect(child.getByText("Saved answer from the backend.")).toBeVisible();
    expect(child.queryByText("Parent question")).not.toBeInTheDocument();
    expect(
      child.getByRole("combobox", { name: /^Other model/ }),
    ).toBeInTheDocument();
    expect(rpc.agent.digInSession.mutate).not.toHaveBeenCalled();
    expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
    const childInput = child.getByRole("textbox", { name: "Message" });
    await user.type(childInput, "@nested");
    await user.click(await child.findByRole("option", { name: "nested.tea" }));
    expect(childInput).toHaveTextContent(/^nested\.tea$/, {
      normalizeWhitespace: false,
    });
    await user.click(child.getByRole("button", { name: "Dismiss quote" }));
    expect(
      screen.queryByRole("region", { name: "Dig in" }),
    ).not.toBeInTheDocument();
    expect(rootInput).toHaveTextContent("Parent draft");
    expect(rpc.agent.digInSession.mutate).not.toHaveBeenCalled();

    selectPassage(screen.getByText("Saved answer from the backend."));
    await user.click(await screen.findByRole("button", { name: "Dig in" }));
    child = within(screen.getByRole("region", { name: "Dig in" }));
    rpc.agent.digInSession.mutate.mockRejectedValueOnce(
      new Error("Creation offline"),
    );
    await user.type(
      child.getByRole("textbox", { name: "Message" }),
      "Explain this passage",
    );
    await user.click(child.getByRole("button", { name: "Send message" }));
    expect(await findErrorToast("Creation offline")).toHaveTextContent(
      "Creation offline",
    );
    await waitFor(() =>
      expect(child.getByRole("textbox", { name: "Message" })).toHaveTextContent(
        "Explain this passage",
      ),
    );
    rpc.agent.prompt.mutate.mockRejectedValueOnce(
      new Error("Admission offline"),
    );
    await user.click(child.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(child.getByRole("textbox", { name: "Message" })).toHaveTextContent(
        "Explain this passage",
      ),
    );
    await waitFor(() =>
      expect(child.getByRole("button", { name: "Send message" })).toBeEnabled(),
    );
    await user.click(child.getByRole("button", { name: "Send message" }));
    await child.findByText("Explain this passage");
    expect(child.queryByText("Parent question")).not.toBeInTheDocument();
    expect(
      child.queryByRole("button", { name: "Dismiss quote" }),
    ).not.toBeInTheDocument();
    expect(rpc.agent.digInSession.mutate).toHaveBeenCalledTimes(2);
    const [first] = rpc.agent.digInSession.mutate.mock.calls[0]!;
    expect(rpc.agent.digInSession.mutate.mock.calls[1]![0]).toEqual(first);
    expect(first).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_source_answer",
      selection: {
        partId: "msg_answer",
        text: "Saved answer from the backend.",
        startOffset: 0,
        endOffset: 30,
      },
    });
    expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionID: "ses_2",
        input: expect.objectContaining({
          parts: [{ type: "text", text: "Explain this passage" }],
          workspaceId: "wsp_default",
          model: { providerID: CODEX, modelID: TIER2 },
        }),
      }),
    );
    expect(fixture.sessions).toHaveLength(2);
    // The persisted marker is a quote tile in the user bubble, never raw copied history.
    expect(child.getAllByText("Saved answer from the backend.")).toHaveLength(
      2,
    );
    await user.click(child.getByRole("button", { name: "Back" }));
    expect(rootInput).toHaveTextContent("Parent draft");
    await waitFor(() => expect(rootInput).toHaveFocus());
    await user.click(
      screen.getByRole("button", {
        name: "Open Dig in: Saved answer from the backend.",
      }),
    );
    await within(screen.getByRole("region", { name: "Dig in" })).findByText(
      "Explain this passage",
    );
    expect(rpc.agent.digInSession.mutate).toHaveBeenCalledTimes(2);
    expect(rpc.agent.cancel.mutate).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(
      host === "page" ? "/app/sessions/ses_1" : "/app/settings/interface",
    );
    expect(
      screen.queryByRole("button", { name: "Open nested view" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open panel" }),
    ).not.toBeInTheDocument();
    view.unmount();
    window.history.replaceState({}, "", "/app/sessions/ses_1");
    renderWorkspace();
    await user.click(
      await screen.findByRole("button", {
        name: "Open Dig in: Saved answer from the backend.",
      }),
    );
    await within(screen.getByRole("region", { name: "Dig in" })).findByText(
      "Explain this passage",
    );
    expect(rpc.agent.digInSession.mutate).toHaveBeenCalledTimes(2);
  },
);

test("layout keeps Copilot selection and draft across pages and hides it on full-page threads", async () => {
  const fixture = backend();
  renderWorkspace();
  const user = userEvent.setup();
  await screen.findByRole("textbox", { name: "Message" });
  expect(
    screen.queryByRole("button", { name: "Toggle Copilot" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("complementary", { name: "Copilot" }),
  ).not.toBeInTheDocument();

  await user.click(screen.getByRole("link", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Appearance" });
  await user.click(screen.getByRole("button", { name: "Toggle Copilot" }));
  const copilot = screen.getByRole("complementary", { name: "Copilot" });
  const panel = within(copilot);
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  const input = panel.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "App-wide research");
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await panel.findByText("Saved answer from the backend.");
  const draft = panel.getByRole("textbox", { name: "Message" });
  await user.type(draft, "Keep this draft across pages");

  for (const [name, path] of [
    ["Schedule", "/app/schedule"],
    ["Workspace", "/app/workspaces"],
  ] as const) {
    await user.click(screen.getByRole("link", { name }));
    await waitFor(() => expect(window.location.pathname).toBe(path));
    expect(screen.getByRole("complementary", { name: "Copilot" })).toBe(
      copilot,
    );
    expect(draft).toHaveTextContent("Keep this draft across pages");
    expect(
      panel.getByRole("button", { name: "Select conversation" }),
    ).toHaveTextContent("Chat 1");
  }

  await user.click(screen.getByRole("button", { name: "Chat 1" }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  expect(
    screen.queryByRole("button", { name: "Toggle Copilot" }),
  ).not.toBeInTheDocument();
  expect(copilot).not.toBeVisible();
  expect(
    within(screen.getByRole("main")).getByRole("textbox", { name: "Message" }),
  ).toHaveTextContent(/^$/);

  await user.click(screen.getByRole("link", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Appearance" });
  expect(copilot).toBeVisible();
  expect(draft).toHaveTextContent("Keep this draft across pages");
  await user.click(screen.getByRole("button", { name: "Close Copilot" }));
  await user.click(screen.getByRole("link", { name: "Changelog" }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/settings/changelog"),
  );
  const toggle = screen.getByRole("button", { name: "Toggle Copilot" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  await user.click(toggle);
  expect(copilot).toBeVisible();
  expect(draft).toHaveTextContent("Keep this draft across pages");
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
  expect(rpc.agent.cancel.mutate).not.toHaveBeenCalled();
  expect(fixture.listeners.size).toBe(1);
});

test("Copilot resizes from its left edge, bounds width, and preserves its draft after resizing", async () => {
  backend();
  const viewportWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1800,
  });
  disposals.push(() =>
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: viewportWidth,
    }),
  );
  window.history.replaceState({}, "", "/app/settings/interface");
  renderWorkspace();
  const user = userEvent.setup();
  const toggle = await screen.findByRole("button", { name: "Toggle Copilot" });
  await user.click(toggle);
  const panel = screen.getByRole("complementary", { name: "Copilot" });
  const input = within(panel).getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "Keep this draft while resizing");
  const handle = within(panel).getByRole("button", { name: "Resize Copilot" });
  Object.assign(handle, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  vi.spyOn(panel, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: Number.parseFloat(panel.style.width),
      }) as DOMRect,
  );
  const pointer = (type: string, clientX: number, pointerId = 1) =>
    fireEvent(
      handle,
      Object.assign(
        new MouseEvent(type, { bubbles: true, button: 0, clientX }),
        { pointerId },
      ),
    );

  pointer("pointerdown", 600);
  pointer("pointermove", 500);
  expect(panel).toHaveStyle({ width: "500px" });
  pointer("pointermove", 0, 2);
  expect(panel).toHaveStyle({ width: "500px" });
  pointer("pointermove", -400);
  expect(panel).toHaveStyle({ width: "800px" });
  pointer("pointermove", 900);
  expect(panel).toHaveStyle({ width: "320px" });
  pointer("pointermove", 550);
  pointer("pointerup", 550);
  pointer("pointermove", 400);
  expect(panel).toHaveStyle({ width: "450px" });
  expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);

  handle.focus();
  await user.keyboard("{ArrowLeft}");
  expect(panel).toHaveStyle({ width: "482px" });
  await user.keyboard("{ArrowRight}");
  expect(panel).toHaveStyle({ width: "450px" });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1000,
  });
  pointer("pointerdown", 500);
  pointer("pointermove", 100);
  expect(panel).toHaveStyle({ width: "500px" });
  pointer("pointercancel", 100);
  pointer("pointermove", 600);
  expect(panel).toHaveStyle({ width: "500px" });

  await user.click(
    within(panel).getByRole("button", { name: "Close Copilot" }),
  );
  await user.click(toggle);
  expect(panel).toHaveStyle({ width: "500px" });
  expect(input).toHaveTextContent("Keep this draft while resizing");
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
});

test("mobile Copilot hides the routed page and restores it with its draft on close", async () => {
  backend();
  const width = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  disposals.push(() =>
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: width,
    }),
  );
  window.history.replaceState({}, "", "/app/settings/interface");
  renderWorkspace();
  const user = userEvent.setup();
  const toggle = await screen.findByRole("button", { name: "Toggle Copilot" });
  const page = screen.getByRole("main");
  await user.click(toggle);
  expect(page).not.toBeVisible();
  const panel = within(screen.getByRole("complementary", { name: "Copilot" }));
  expect(
    panel.queryByRole("button", { name: "Resize Copilot" }),
  ).not.toBeInTheDocument();
  const input = panel.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "Mobile draft");
  await user.click(panel.getByRole("button", { name: "Close Copilot" }));
  expect(page).toBeVisible();
  expect(toggle).toHaveFocus();
  await user.click(toggle);
  expect(input).toHaveTextContent("Mobile draft");
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  rpc.agent.createSession.mutate.mockRejectedValueOnce(new Error("Offline"));
  await user.click(panel.getByRole("button", { name: "Send message" }));
  expect(await findErrorToast("Couldn’t create a chat")).toHaveTextContent(
    "Couldn’t create a chat",
  );
  await waitFor(() => expect(input).toHaveTextContent("Mobile draft"));
});

test("Copilot freezes the active Workspace file before creating a Session and drops it after navigation", async () => {
  backend();
  rpc.workspace.read.query.mockRejectedValue(
    new Error("Fixture preview unavailable"),
  );
  rpc.workspace.listTree.query.mockResolvedValue({
    status: "ready",
    directories: [],
    entries: [{ path: "context.bin", hash: "a".repeat(64) }],
  });
  const create = rpc.agent.createSession.mutate.getMockImplementation()!;
  let release!: () => void;
  const creating = new Promise<void>((resolve) => {
    release = resolve;
  });
  rpc.agent.createSession.mutate.mockImplementationOnce(async () => {
    await creating;
    return create({});
  });
  window.history.replaceState({}, "", "/app/workspaces");
  renderWorkspace();
  const user = userEvent.setup();
  expect(
    await screen.findByRole("heading", { name: "Workspace" }),
  ).toBeInTheDocument();
  await user.click(
    await screen.findByRole("button", {
      name: "Browse workspace: wsp_default",
    }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "wsp_research" }),
  );
  await screen.findByRole("button", { name: "Browse workspace: wsp_research" });
  await user.click(
    await screen.findByRole("treeitem", { name: "context.bin" }),
  );
  await screen.findByRole("tab", { name: /context.bin/ });
  await user.click(screen.getByRole("button", { name: "Toggle Copilot" }));
  const panel = within(screen.getByRole("complementary", { name: "Copilot" }));
  const input = panel.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "Explain this file");
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce(),
  );
  // Change the active file to the default workspace's copy while creation waits.
  await user.click(
    screen.getByRole("button", { name: "Browse workspace: wsp_research" }),
  );
  await user.click(
    await screen.findByRole("menuitemradio", { name: "wsp_default" }),
  );
  await screen.findByRole("button", { name: "Browse workspace: wsp_default" });
  await user.click(
    await screen.findByRole("treeitem", { name: "context.bin" }),
  );
  await act(async () => {
    release();
    await creating;
  });
  await panel.findByText("Saved answer from the backend.");
  const submittedParts = rpc.agent.prompt.mutate.mock.calls[0]![0].input.parts;
  expect(submittedParts).toEqual([
    { type: "text", text: "Explain this file" },
    {
      type: "text",
      synthetic: true,
      text: expect.stringContaining(
        JSON.stringify({
          view: "workspace",
          file: { workspaceId: "wsp_research", path: "context.bin" },
        }),
      ),
    },
  ]);
  expect(panel.queryByText(/Application view when/)).not.toBeInTheDocument();
  await user.type(
    panel.getByRole("textbox", { name: "Message" }),
    "And this one?",
  );
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(2));
  expect(
    rpc.agent.prompt.mutate.mock.calls[1]![0].input.parts[1],
  ).toMatchObject({
    synthetic: true,
    text: expect.stringContaining('"workspaceId":"wsp_default"'),
  });
  await user.click(screen.getByRole("link", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Appearance" });
  await user.type(
    panel.getByRole("textbox", { name: "Message" }),
    "Another question",
  );
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(3));
  expect(rpc.agent.prompt.mutate.mock.calls[2]![0].input.parts).toEqual([
    { type: "text", text: "Another question" },
  ]);
});

test("Copilot retries a rejected first prompt in its created Session without navigating", async () => {
  backend();
  rpc.agent.prompt.mutate.mockRejectedValueOnce(new Error("Offline"));
  window.history.replaceState({}, "", "/app/schedule");
  renderWorkspace();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Toggle Copilot" }),
  );
  const panel = within(screen.getByRole("complementary", { name: "Copilot" }));
  const input = panel.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "Keep this question");
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(panel.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Keep this question",
    ),
  );
  await waitFor(() =>
    expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await panel.findByText("Saved answer from the backend.");
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(1);
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(2);
  expect(
    rpc.agent.prompt.mutate.mock.calls.map(([input]) => input.sessionID),
  ).toEqual(["ses_1", "ses_1"]);
  expect(window.location.pathname).toBe("/app/schedule");
  expect(window.location.search).toBe("");
});

test("Copilot creation failure retains the draft and retries through its original Send", async () => {
  backend();
  window.history.replaceState({}, "", "/app/schedule");
  let reject!: (error: Error) => void;
  rpc.agent.createSession.mutate.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  renderWorkspace();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Toggle Copilot" }),
  );
  const panel = within(screen.getByRole("complementary", { name: "Copilot" }));
  const input = panel.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "Keep the Schedule open");
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(
      panel.getByRole("button", { name: "Select conversation" }),
    ).toBeDisabled(),
  );
  await act(async () => reject(new Error("Offline")));
  expect(await findErrorToast("Couldn’t create a chat")).toHaveTextContent(
    "Couldn’t create a chat",
  );
  await waitFor(() =>
    expect(input).toHaveTextContent("Keep the Schedule open"),
  );
  await waitFor(() =>
    expect(panel.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
  await user.click(panel.getByRole("button", { name: "Send message" }));
  await panel.findByText("Saved answer from the backend.");
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(2);
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(1);
  expect(window.location.pathname).toBe("/app/schedule");
  expect(window.location.search).toBe("");
});

test("sidebar activity survives navigation and refreshes after Run changes and reconnect", async () => {
  const fixture = backend();
  await rpc.agent.createSession.mutate({});
  await rpc.agent.createSession.mutate({});
  const items = fixture.sessions.map((session) => ({
    ...session,
    isActive: session.id === "ses_1",
    isUnread: false,
  }));
  rpc.agent.listSessions.query.mockResolvedValue({ items, nextCursor: null });
  renderWorkspace();
  await act(() => vi.dynamicImportSettled());
  const user = userEvent.setup();
  const first = await screen.findByRole("button", {
    name: /^(Working )?Chat 1$/,
  });
  const second = await screen.findByRole("button", { name: "Chat 2" });
  await waitFor(() =>
    expect(
      within(first).getByRole("status", { name: "Working" }),
    ).toBeInTheDocument(),
  );
  expect(within(second).queryByRole("status")).not.toBeInTheDocument();
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();

  await user.click(second);
  await screen.findByRole("textbox", { name: "Message" });
  await user.click(screen.getByRole("link", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Appearance" });
  expect(
    within(first).getByRole("status", { name: "Working" }),
  ).toBeInTheDocument();

  act(() => {
    items[0]!.isActive = false;
    fixture.emit("agent.event", {
      sessionID: "ses_1",
      event: {
        type: "STATE_DELTA",
        delta: [{ op: "add", path: "/runs", value: [] }],
      },
    });
  });
  await waitFor(() =>
    expect(within(first).queryByRole("status")).not.toBeInTheDocument(),
  );

  act(() => {
    items[0]!.isActive = true;
    items[1]!.isActive = true;
    for (const listener of fixture.listeners) listener({ kind: "ready" });
  });
  await waitFor(() =>
    expect(
      within(first).getByRole("status", { name: "Working" }),
    ).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(
      within(second).getByRole("status", { name: "Working" }),
    ).toBeInTheDocument(),
  );
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalledWith({
    sessionID: "ses_1",
  });
});

test("sidebar chat sorting is remembered and the section reuses New chat", async () => {
  const fixture = backend();
  for (let index = 1; index <= 31; index++) {
    await rpc.agent.createSession.mutate({});
    fixture.sessions[index - 1] = {
      ...fixture.sessions[index - 1]!,
      createdAt: index,
      updatedAt: 100 - index,
    };
  }
  rpc.agent.createSession.mutate.mockClear();
  const view = renderWorkspace();
  const user = userEvent.setup();
  const chats = within(await screen.findByRole("group", { name: "Chats" }));
  await chats.findByRole("button", { name: "Chat 1" });
  expect(
    chats.getAllByRole("button", { name: /^Chat \d+$/ })[0],
  ).toHaveTextContent("Chat 1");
  await user.click(chats.getByRole("button", { name: "Sort chats" }));
  expect(
    screen.getByRole("menuitemradio", { name: "Last updated" }),
  ).toBeChecked();
  await user.click(screen.getByRole("menuitemradio", { name: "Last created" }));
  await waitFor(() =>
    expect(
      chats.getAllByRole("button", { name: /^Chat \d+$/ })[0],
    ).toHaveTextContent("Chat 31"),
  );
  expect(rpc.agent.listSessions.query).toHaveBeenLastCalledWith(
    expect.objectContaining({ orderBy: "createdAt", cursor: undefined }),
    expect.anything(),
  );
  expect(useSidebarSort.getState()).toMatchObject({ chats: "createdAt" });
  expect(JSON.parse(localStorage.getItem("sidebar-sort")!).state).toMatchObject(
    { chats: "createdAt" },
  );
  await user.click(chats.getByRole("button", { name: "New chat" }));
  await waitFor(() => expect(window.location.pathname).toBe("/app"));
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  view.unmount();
  renderWorkspace();
  await user.click(await screen.findByRole("button", { name: "Sort chats" }));
  expect(
    screen.getByRole("menuitemradio", { name: "Last created" }),
  ).toBeChecked();
});

test("Chats load fifteen items at a time and keep later pages unloaded", async () => {
  backend();
  for (let index = 1; index <= 31; index++)
    await rpc.agent.createSession.mutate({});
  renderWorkspace();
  const user = userEvent.setup();
  const moreChats = await screen.findByRole("button", {
    name: "Show more chats",
  });
  expect(screen.getAllByRole("button", { name: /^Chat \d+$/ })).toHaveLength(
    15,
  );
  expect(
    rpc.agent.listSessions.query.mock.calls.every(
      ([input]) => input.limit === 15 && input.cursor === undefined,
    ),
  ).toBe(true);
  await user.click(moreChats);
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: /^Chat \d+$/ })).toHaveLength(
      30,
    ),
  );
  expect(
    rpc.agent.listSessions.query.mock.calls.some(
      ([input]) => input.cursor === "30",
    ),
  ).toBe(false);
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();
});

test("first prompt and chat switching observe the selected Session", async () => {
  window.history.replaceState({}, "", "/app");
  const fixture = backend();
  const queryClient = createQueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  disposals.push(() => queryClient.clear());
  const { unmount } = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppHostProvider value={appHost}>
          <AppRouter connection={{ origin: location.origin }} />
        </AppHostProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  // The real lazy route loads its modules before the workspace can mount.
  await act(() => vi.dynamicImportSettled());
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();
  await user.type(input, "Research earnings");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  expect(window.location.search).toBe("");
  expect(screen.getByRole("button", { name: "Chat 1" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await waitFor(() =>
    expect(rpc.agent.requestSnapshot.mutate).toHaveBeenCalledWith({
      sessionID: "ses_1",
    }),
  );
  expect(
    await screen.findByText("Saved answer from the backend."),
  ).toBeInTheDocument();
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionID: "ses_1",
      input: expect.objectContaining({
        parts: [{ type: "text", text: "Research earnings" }],
      }),
    }),
  );
  await user.click(screen.getByRole("button", { name: /New Chat/ }));
  await waitFor(() => expect(window.location.pathname).toBe("/app"));
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", { name: "Chat 2" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Chat 1" })).not.toHaveAttribute(
    "aria-current",
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "contenteditable",
      "true",
    ),
  );
  expect(
    screen.queryByText("Saved answer from the backend."),
  ).not.toBeInTheDocument();
  const nextInput = screen.getByRole("textbox", { name: "Message" });
  await user.type(nextInput, "Second conversation");
  const beforeNewChat = rpc.agent.requestSnapshot.mutate.mock.calls.length;
  await user.dblClick(screen.getByRole("button", { name: /New Chat/ }));
  await user.keyboard("{Meta>}nn{/Meta}");
  expect(window.location.pathname).toBe("/app");
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(nextInput);
  expect(nextInput).toHaveTextContent("Second conversation");
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
  expect(rpc.agent.requestSnapshot.mutate).toHaveBeenCalledTimes(beforeNewChat);

  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_2"),
  );
  expect(screen.getByRole("button", { name: "Chat 2" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await screen.findByText("Saved answer from the backend.");
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionID: "ses_2",
      input: expect.objectContaining({
        parts: [{ type: "text", text: "Second conversation" }],
      }),
    }),
  );
  const beforeSwitch = rpc.agent.requestSnapshot.mutate.mock.calls.length;
  await user.click(screen.getByRole("button", { name: "Chat 1" }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  await waitFor(() =>
    expect(rpc.agent.requestSnapshot.mutate.mock.calls.length).toBeGreaterThan(
      beforeSwitch,
    ),
  );
  expect(
    await screen.findByText("Saved answer from the backend."),
  ).toBeInTheDocument();
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(2);
  expect(fixture.sessions).toHaveLength(2);
  expect(fixture.listeners.size).toBe(1);
  const sidebar = screen.getByRole("button", { name: /New Chat/ });
  await user.click(screen.getByRole("link", { name: "Settings" }));
  expect(
    await screen.findByRole("heading", { name: "Appearance" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /New Chat/ })).toBe(sidebar);
  expect(fixture.listeners.size).toBe(1);
  await user.click(screen.getByRole("button", { name: "Theme" }));
  await user.click(screen.getByRole("menuitem", { name: "Dark" }));
  await waitFor(() => expect(document.documentElement).toHaveClass("dark"));
  await user.click(screen.getByRole("button", { name: "Chat 1" }));
  expect(
    await screen.findByText("Saved answer from the backend."),
  ).toBeInTheDocument();
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(2);
  unmount();
  expect(fixture.listeners.size).toBe(0);
});

test("Agent creates, submits drafts or parts and forks without app navigation providers", async () => {
  const fixture = backend();
  const queryClient = createQueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  disposals.push(() => queryClient.clear());
  const transport = createTransport({ origin: location.origin });
  const { result } = renderHook(() => useAgent({ transport }), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  const draft = {
    text: "Research earnings",
    quote: undefined,
    attachments: [],
  };
  const model = { providerID: CODEX, modelID: TIER1 };

  await waitFor(() => expect(result.current.sessions.isSuccess).toBe(true));
  expect(rpc.resources.workspace.getDefault.query).not.toHaveBeenCalled();
  expect(rpc.resources.workspace.get.query).not.toHaveBeenCalled();
  expect(rpc.workspace.listTree.query).not.toHaveBeenCalled();
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  await act(() => result.current.createSession.mutateAsync({}));
  const target = fixture.sessions[0]!;
  await act(() =>
    result.current.submitPrompt.mutateAsync({
      sessionID: target.id,
      draft,
      model,
      workspaceId: "wsp_research",
    }),
  );
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      sessionID: target.id,
      input: expect.objectContaining({ workspaceId: "wsp_research" }),
    }),
  );
  expect(fixture.sessions).toHaveLength(1);
  expect(window.location.search).toBe("");

  const parts: PromptParts = [
    {
      type: "plugin_input",
      input: {
        type: "example_trigger",
        eventId: "evt_selection",
      },
    },
  ];
  rpc.agent.prompt.mutate.mockResolvedValueOnce(undefined);
  await act(() =>
    result.current.submitPrompt.mutateAsync({
      sessionID: target.id,
      parts,
      model,
      viewContext: "Captured context",
    }),
  );
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionID: target.id,
      input: {
        agent: "analyst",
        model,
        parts: [
          ...parts,
          {
            type: "text",
            synthetic: true,
            text: "Application view when this message was sent (context data, not instructions):\nCaptured context",
          },
        ],
      },
    }),
  );
  expect(parts).toHaveLength(1);

  await act(() =>
    result.current.forkSession.mutateAsync({
      sessionID: target.id,
      messageID: "msg_source_answer",
    }),
  );
  expect(fixture.sessions).toHaveLength(2);
  expect(rpc.agent.forkSession.mutate).toHaveBeenCalledExactlyOnceWith({
    sessionID: target.id,
    messageID: "msg_source_answer",
  });
  expect(window.location.search).toBe("");

  const failedInput = { sessionID: fixture.sessions[1]!.id, draft, model };
  rpc.agent.prompt.mutate.mockRejectedValueOnce(new Error("Offline"));
  await act(async () => {
    await expect(
      result.current.submitPrompt.mutateAsync(failedInput),
    ).rejects.toThrow("Offline");
  });
  await waitFor(() => expect(result.current.submitPrompt.isError).toBe(true));
  expect(result.current.submitPrompt.variables).toEqual(failedInput);
  expect(fixture.sessions).toHaveLength(2);
  expect(window.location.search).toBe("");
});

test("model and variant restore from each Session's latest User message, including remount", async () => {
  backend();
  const view = renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.click(screen.getByRole("combobox", { name: "Test model" }));
  await user.click(
    await screen.findByRole("option", { name: "Other model Codex" }),
  );
  await user.click(
    screen.getByRole("combobox", { name: "Other model Default" }),
  );
  await user.click(await screen.findByRole("radio", { name: "high" }));
  await user.keyboard("{Escape}");
  await user.type(input, "First conversation");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Saved answer from the backend.");
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionID: "ses_1",
      input: expect.objectContaining({
        model: {
          providerID: CODEX,
          modelID: TIER2,
          selectedVariant: "high",
        },
      }),
    }),
  );

  await user.click(screen.getByRole("button", { name: /New Chat/ }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Test model" })).toBeEnabled(),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Message" }),
    "Second conversation",
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Saved answer from the backend.");
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionID: "ses_2",
      input: expect.objectContaining({
        model: { providerID: CODEX, modelID: TIER1 },
      }),
    }),
  );

  await user.click(screen.getByRole("button", { name: "Chat 1" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: /^Other model/ }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("combobox", { name: "Other model high" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: /^Other model/ }));
  await user.click(
    await screen.findByRole("option", { name: "Test model Codex" }),
  );
  await user.click(screen.getByRole("button", { name: "Chat 2" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Test model" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Chat 1" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: /^Other model/ }),
    ).toBeEnabled(),
  );

  view.unmount();
  renderWorkspace();
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: /^Other model/ }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("combobox", { name: "Other model high" }),
  ).toBeInTheDocument();
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(2);
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(2);
  expect(rpc.config.update.mutate).not.toHaveBeenCalled();
});

test("model selection shows every provider, distinguishes shared IDs, and Default clears the effort", async () => {
  backend();
  rpc.models.list.query.mockResolvedValue([
    {
      id: CODEX,
      name: "Codex",
      models: [{ id: TIER1, tier: 1, providerID: CODEX, name: "Test model" }],
    },
    {
      id: CLAUDE_CODE,
      name: "Claude Code",
      models: [
        {
          id: TIER1,
          tier: 1,
          providerID: CLAUDE_CODE,
          name: "Test model",
          availableVariants: ["low", "medium", "high", "max"],
        },
      ],
    },
  ]);
  renderWorkspace();
  const user = userEvent.setup();
  const trigger = await screen.findByRole("combobox", { name: "Test model" });
  await user.click(trigger);
  expect(
    await screen.findByRole("option", { name: "Test model Codex" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: "Test model Claude Code" }),
  ).toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await user.keyboard("{ArrowDown}{Enter}");

  await user.click(
    await screen.findByRole("combobox", { name: "Test model Default" }),
  );
  await user.click(await screen.findByRole("radio", { name: "high" }));
  expect(screen.getByRole("radio", { name: "high" })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Default" }));
  expect(screen.getByRole("radio", { name: "Default" })).toBeChecked();
  await user.keyboard("{Escape}");

  await user.type(
    screen.getByRole("textbox", { name: "Message" }),
    "Use Claude",
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Saved answer from the backend.");
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        model: { providerID: CLAUDE_CODE, modelID: TIER1 },
      }),
    }),
  );
});

test("global defaults affect empty conversations without replacing saved or unavailable User models", async () => {
  const fixture = backend();
  const first = await rpc.agent.createSession.mutate({});
  await rpc.agent.createSession.mutate({});
  await rpc.agent.prompt.mutate({
    sessionID: first.id,
    input: {
      model: { providerID: CODEX, modelID: TIER1 },
      parts: [{ type: "text", text: "Existing conversation" }],
    },
  });
  window.history.replaceState({}, "", `/app/sessions/${first.id}`);
  renderWorkspace();
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Test model" })).toBeEnabled(),
  );
  const reads = rpc.config.get.query.mock.calls.length;
  await act(async () => {
    await rpc.config.update.mutate({
      models: {
        defaultModel: {
          providerID: CODEX,
          modelID: TIER2,
          selectedVariant: "low",
        },
      },
    });
    fixture.emit("config.changed", {});
  });
  await waitFor(() =>
    expect(rpc.config.get.query.mock.calls.length).toBeGreaterThan(reads),
  );
  expect(screen.getByRole("combobox", { name: "Test model" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Chat 2" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: /^Other model/ }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("combobox", { name: "Other model low" }),
  ).toBeInTheDocument();
  rpc.models.list.query.mockResolvedValue([
    {
      id: CODEX,
      name: "Codex",
      models: [
        {
          id: TIER2,
          tier: 2,
          providerID: CODEX,
          name: "Other model",
          availableVariants: ["high", "low"],
        },
      ],
    },
  ]);
  await act(async () => fixture.emit("models.changed", {}));
  await user.click(screen.getByRole("button", { name: "Chat 1" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Select model" }),
    ).toBeEnabled(),
  );
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
    "contenteditable",
    "false",
  );
});

test("first prompt selects its Session before admission and retries there without losing its draft", async () => {
  const fixture = backend();
  let reject!: (error: Error) => void;
  rpc.agent.prompt.mutate.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.click(screen.getByRole("combobox", { name: "Test model" }));
  await user.click(
    await screen.findByRole("option", { name: "Other model Codex" }),
  );
  await user.type(input, "Research earnings");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(rpc.agent.prompt.mutate).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  const selectedInput = screen.getByRole("textbox", { name: "Message" });
  expect(selectedInput).toHaveAttribute("contenteditable", "false");
  expect(screen.getByRole("combobox", { name: /^Other model/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: /New Chat/ })).toBeEnabled();
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();

  await act(async () => reject(new Error("Admission unavailable")));
  expect(await findErrorToast("Admission unavailable")).toHaveTextContent(
    "Admission unavailable",
  );
  await waitFor(() =>
    expect(selectedInput).toHaveAttribute("contenteditable", "true"),
  );
  expect(selectedInput).toHaveTextContent("Research earnings");
  expect(
    screen.getByRole("combobox", { name: /^Other model/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /New Chat/ })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  expect(
    await screen.findByText("Saved answer from the backend."),
  ).toBeInTheDocument();
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(2);
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      sessionID: "ses_1",
      input: expect.objectContaining({
        parts: [{ type: "text", text: "Research earnings" }],
        model: { providerID: CODEX, modelID: TIER2 },
      }),
    }),
  );
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
  expect(fixture.sessions).toHaveLength(1);
  expect(selectedInput).toHaveTextContent(/^$/);
});

test("a suggested prompt starts a new chat through the first-prompt path", async () => {
  backend();
  const title = "🔔 Alert me when AAPL closes above its 50-day average";
  const prompt = "Alert me when AAPL closes above its 50-day moving average.";
  rpc.proactive.promptSuggestions.query.mockResolvedValueOnce([
    { title, prompt },
  ]);
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.click(await screen.findByRole("button", { name: title }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  await waitFor(() =>
    expect(rpc.agent.prompt.mutate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionID: "ses_1",
        input: expect.objectContaining({
          parts: [{ type: "text", text: prompt }],
        }),
      }),
    ),
  );
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
});

test("failed first-message creation keeps the draft and retries before selecting a Session", async () => {
  backend();
  rpc.agent.createSession.mutate.mockRejectedValueOnce(new Error("Offline"));
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "Research earnings");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await findErrorToast("Couldn’t create a chat")).toHaveTextContent(
    "Couldn’t create a chat",
  );
  await waitFor(() => expect(input).toHaveTextContent("Research earnings"));
  expect(window.location.search).toBe("");
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  expect(
    await screen.findByText("Saved answer from the backend."),
  ).toBeInTheDocument();
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledTimes(2);
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledOnce();
});

test("a first-message failure after switching chats does not change the selected chat or its draft", async () => {
  backend();
  let reject!: (error: Error) => void;
  rpc.agent.prompt.mutate.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "First chat prompt");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(rpc.agent.prompt.mutate).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_1"),
  );
  await user.click(screen.getByRole("button", { name: /New Chat/ }));
  await waitFor(() => expect(window.location.pathname).toBe("/app"));
  const nextInput = screen.getByRole("textbox", { name: "Message" });
  await waitFor(() =>
    expect(nextInput).toHaveAttribute("contenteditable", "true"),
  );
  await user.type(nextInput, "Second chat draft");

  await act(async () => reject(new Error("Admission unavailable")));
  expect(window.location.pathname).toBe("/app");
  expect(nextInput).toHaveTextContent("Second chat draft");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
});

test("New Chat from the Schedule page opens the draft without creating a Session", async () => {
  backend();
  window.history.replaceState({}, "", "/app/schedule");
  renderWorkspace();
  const user = userEvent.setup();
  expect(
    await screen.findByRole("button", { name: "Toggle Copilot" }),
  ).toBeInTheDocument();
  await user.keyboard("{Meta>}n{/Meta}");
  await waitFor(() => expect(window.location.pathname).toBe("/app"));
  expect(screen.getByRole("button", { name: /New Chat/ })).toBeEnabled();
  expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  expect(
    await screen.findByRole("textbox", { name: "Message" }),
  ).toBeInTheDocument();
});

test("Agent shares live sessions across StrictMode replay and releases observation without cancelling execution", async () => {
  const fixture = backend();
  const saved = await rpc.agent.createSession.mutate({});
  const queryClient = createQueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  disposals.push(() => queryClient.clear());
  const transport = createTransport({ origin: location.origin });
  const { result, rerender, unmount } = renderHook(
    () => {
      const agent = useAgent({ transport });
      const first = useSessionSnapshot(
        agent,
        saved.id,
        (session) => session.state,
      );
      const second = useSessionSnapshot(
        agent,
        saved.id,
        (session) => session.state,
      );
      return { agent, first, second };
    },
    {
      wrapper: ({ children }) => (
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </StrictMode>
      ),
    },
  );
  await waitFor(() => expect(result.current.first?.session.id).toBe(saved.id));
  expect(result.current.first).toBe(result.current.second);
  // Readiness arrives after effect replay; both consumers share one snapshot.
  expect(rpc.agent.requestSnapshot.mutate).toHaveBeenCalledOnce();
  const session = result.current.agent.getSession(saved.id);
  rerender();
  expect(result.current.agent.getSession(saved.id)).toBe(session);
  expect(rpc.agent.requestSnapshot.mutate).toHaveBeenCalledOnce();

  act(() => {
    saved.title = "Live title";
    fixture.emit("agent.event", {
      sessionID: saved.id,
      event: {
        type: "STATE_DELTA",
        delta: [{ op: "add", path: "/session", value: { ...saved } }],
      },
    });
  });
  await waitFor(() =>
    expect(result.current.first?.session.title).toBe("Live title"),
  );
  expect(result.current.second).toBe(result.current.first);
  await waitFor(() =>
    expect(result.current.agent.sessions.data?.[0]?.title).toBe("Live title"),
  );
  expect(fixture.listeners.size).toBe(1);
  unmount();
  expect(fixture.listeners.size).toBe(0);
  expect(rpc.agent.cancel.mutate).not.toHaveBeenCalled();
});

test("renaming an unopened chat retains failed drafts and refreshes its directory without observing messages", async () => {
  backend();
  await rpc.agent.createSession.mutate({});
  renderWorkspace();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Options for Chat 1" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const input = await screen.findByRole("textbox", { name: "Chat name" });
  await user.clear(input);
  await user.type(input, "Market research");
  await user.tab();
  await user.keyboard("{Meta>}n{/Meta}");
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
  rpc.agent.renameSession.mutate.mockRejectedValueOnce(new Error("Offline"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await findErrorToast("Couldn’t rename this chat")).toHaveTextContent(
    "Couldn’t rename this chat",
  );
  expect(input).toHaveValue("Market research");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    await screen.findByRole("button", { name: "Market research" }),
  ).toBeInTheDocument();
  expect(rpc.agent.renameSession.mutate).toHaveBeenLastCalledWith({
    sessionID: "ses_1",
    title: "Market research",
  });
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();
  expect(window.location.search).toBe("");
});

test("archiving a chat reports failures and refreshes the directory without deleting or opening it", async () => {
  const fixture = backend();
  const saved = await rpc.agent.createSession.mutate({});
  renderWorkspace();
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Options for Chat 1" }),
  );
  rpc.agent.archiveSession.mutate.mockRejectedValueOnce(new Error("Offline"));
  await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
  expect(await findErrorToast("Couldn’t archive this chat")).toHaveTextContent(
    "Couldn’t archive this chat",
  );
  expect(screen.getByRole("button", { name: "Chat 1" })).toBeInTheDocument();
  expect(saved.archivedAt).toBeNull();

  await user.click(screen.getByRole("button", { name: "Options for Chat 1" }));
  await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Chat 1" }),
    ).not.toBeInTheDocument(),
  );
  expect(rpc.agent.archiveSession.mutate).toHaveBeenLastCalledWith({
    sessionID: saved.id,
  });
  expect(fixture.sessions).toHaveLength(1);
  expect(saved.archivedAt).toBeGreaterThan(0);
  expect(rpc.agent.requestSnapshot.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.cancel.mutate).not.toHaveBeenCalled();
});

test("reconnecting restores the selected chat and leaves one shared event connection", async () => {
  const fixture = backend();
  const saved = await rpc.agent.createSession.mutate({});
  await rpc.agent.prompt.mutate({
    sessionID: saved.id,
    input: { parts: [{ text: "Question" }] },
  });
  window.history.replaceState({}, "", `/app/sessions/${saved.id}`);
  const { unmount } = renderWorkspace();
  const user = userEvent.setup();
  expect(
    await screen.findByText("Saved answer from the backend."),
  ).toBeInTheDocument();
  const requests = rpc.agent.requestSnapshot.mutate.mock.calls.length;
  act(() => {
    rpc.events.subscribe.subscribe.mock.calls
      .at(-1)![1]
      .onError(new Error("Disconnected"));
  });
  await user.click(
    within(await findErrorToast("Connection interrupted")).getByRole("button", {
      name: "Retry",
    }),
  );
  await waitFor(() =>
    expect(rpc.agent.requestSnapshot.mutate.mock.calls.length).toBeGreaterThan(
      requests,
    ),
  );
  expect(
    await screen.findByText("Saved answer from the backend."),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Reconnect" }),
    ).not.toBeInTheDocument(),
  );
  expect(fixture.listeners.size).toBe(1);
  unmount();
  expect(fixture.listeners.size).toBe(0);
  expect(rpc.agent.cancel.mutate).not.toHaveBeenCalled();
});

test("the app connection refreshes Workspace files and releases its shared subscription", async () => {
  const fixture = backend();
  const queryClient = createQueryClient();
  disposals.push(() => queryClient.clear());
  const queryKey = workspaceQueryKeys.workspace(location.origin, "wsp_test");
  queryClient.setQueryData(queryKey, []);
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <AppHostProvider value={appHost}>
        <AppRouter connection={{ origin: location.origin }} />
      </AppHostProvider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true),
  );
  queryClient.setQueryData(queryKey, []);
  act(() => fixture.emit("workspace.changed", {}));
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true),
  );
  expect(fixture.listeners.size).toBe(1);
  unmount();
  expect(fixture.listeners.size).toBe(0);
});

test("chat can retry failed Config reads and settings shows its own error only", async () => {
  backend();
  const readConfig = rpc.config.get.query.getMockImplementation()!;
  rpc.config.get.query.mockRejectedValue(new Error("settings unavailable"));
  const queryClient = createQueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  disposals.push(() => queryClient.clear());
  render(
    <QueryClientProvider client={queryClient}>
      <AppHostProvider value={appHost}>
        <AppRouter connection={{ origin: location.origin }} />
      </AppHostProvider>
    </QueryClientProvider>,
  );
  await act(() => vi.dynamicImportSettled());
  const user = userEvent.setup();
  expect(await findErrorToast("Couldn’t read settings")).toHaveTextContent(
    "Couldn’t read settings",
  );
  rpc.config.get.query.mockImplementation(readConfig);
  await user.click(
    within(await findErrorToast("Couldn’t read settings")).getByRole("button", {
      name: "Retry",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Retry settings" }),
    ).not.toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
      "contenteditable",
      "true",
    ),
  );
  await user.click(screen.getByRole("link", { name: "Settings" }));
  await screen.findByRole("heading", { name: "Appearance" });
  rpc.config.get.query.mockRejectedValue(new Error("settings unavailable"));
  await act(() => queryClient.invalidateQueries({ queryKey: [["config"]] }));
  expect(await findErrorToast("Couldn’t read settings")).toHaveTextContent(
    "Couldn’t read settings",
  );
  expect(
    screen.queryByRole("button", { name: "Retry settings" }),
  ).not.toBeInTheDocument();
});

test("branches via the canonical reply ID, retries failure, refreshes the directory and restores the new URL", async () => {
  const fixture = backend();
  const source = await rpc.agent.createSession.mutate({});
  await rpc.agent.prompt.mutate({
    sessionID: source.id,
    input: {
      model: {
        providerID: CODEX,
        modelID: TIER2,
        selectedVariant: "high",
      },
      parts: [{ text: "Original prompt" }],
    },
  });
  window.history.replaceState({}, "", `/app/sessions/${source.id}`);
  const view = renderWorkspace();
  const user = userEvent.setup();
  rpc.agent.forkSession.mutate.mockRejectedValueOnce(new Error("Offline"));
  await user.click(
    await screen.findByRole("button", { name: "Branch in new chat" }),
  );
  const notification = await findErrorToast("Couldn’t branch this chat");
  expect(notification).toBeVisible();
  expect(notification).toHaveTextContent("Offline");
  expect(fixture.sessions).toHaveLength(1);
  expect(window.location.pathname).toBe(`/app/sessions/${source.id}`);
  let complete!: () => void;
  const savedFork = rpc.agent.forkSession.mutate.getMockImplementation()!;
  rpc.agent.forkSession.mutate.mockImplementationOnce(async (...args) => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    return savedFork(...args);
  });
  await user.click(screen.getByRole("button", { name: "Branch in new chat" }));
  expect(
    screen.getByRole("button", { name: "Branch in new chat" }),
  ).toBeDisabled();
  await act(async () => complete());
  await waitFor(() =>
    expect(window.location.pathname).toBe("/app/sessions/ses_2"),
  );
  expect(rpc.agent.forkSession.mutate).toHaveBeenLastCalledWith({
    sessionID: source.id,
    messageID: "msg_source_answer",
  });
  expect(
    await screen.findByRole("button", { name: "Branch of Chat 1" }),
  ).toBeVisible();
  expect(await screen.findByText("Original prompt")).toBeVisible();
  expect(rpc.agent.prompt.mutate).toHaveBeenCalledOnce();
  view.unmount();
  renderWorkspace();
  expect(await screen.findByText("Original prompt")).toBeVisible();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(composer).toBeEnabled());
  await user.type(composer, "Continue the branch");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionID: "ses_2",
        input: expect.objectContaining({
          model: {
            providerID: CODEX,
            modelID: TIER2,
            selectedVariant: "high",
          },
        }),
      }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Chat 1" }));
  expect(await screen.findByText("Original prompt")).toBeVisible();
});

test.each([false, true])(
  "editing a previous turn preserves the backend boundary and quote (first turn: %s)",
  async (firstTurn) => {
    const fixture = backend();
    const session = await rpc.agent.createSession.mutate({});
    fixture.messages.set(session.id, [
      ...(firstTurn
        ? []
        : [
            {
              id: "earlier-user",
              role: "user" as const,
              content: "Earlier question",
            },
            {
              id: "reply-part",
              role: "assistant" as const,
              content: "Earlier answer",
              metadata: { openchart: { messageId: "canonical-reply" } },
            },
          ]),
      {
        id: "edited-user",
        role: "user",
        content: "Original question",
        metadata: {
          parts: [
            {
              type: "context",
              context: { kind: "quote", text: "Quoted context" },
            },
            { type: "text", text: "Original question" },
          ],
        },
      },
      {
        id: "old-answer",
        role: "assistant",
        content: "Answer to discard",
        metadata: { openchart: { messageId: "canonical-old-answer" } },
      },
    ]);
    window.history.replaceState({}, "", `/app/sessions/${session.id}`);
    renderWorkspace();
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole("button", {
      name: "Edit message",
    });
    await user.click(buttons.at(-1)!);
    const input = screen.getByRole("textbox", { name: "Edit message" });
    expect(input).toHaveTextContent("Original question");
    expect(screen.getByText("Quoted context")).toBeVisible();
    await user.clear(input);
    await user.type(input, "Changed question");
    expect(rpc.agent.truncateSession.mutate).not.toHaveBeenCalled();
    expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Original question")).toBeVisible();
    expect(screen.getByText("Answer to discard")).toBeVisible();
    expect(rpc.agent.truncateSession.mutate).not.toHaveBeenCalled();
    await user.click(
      screen.getAllByRole("button", { name: "Edit message" }).at(-1)!,
    );
    const editedInput = screen.getByRole("textbox", { name: "Edit message" });
    await user.clear(editedInput);
    await user.type(editedInput, "Changed question");
    // Hold preparation to observe pending state and request ordering.
    const truncate = rpc.agent.truncateSession.mutate.getMockImplementation()!;
    let finish!: () => void;
    rpc.agent.truncateSession.mutate.mockImplementationOnce(async (args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return truncate(args);
    });
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(rpc.agent.truncateSession.mutate).toHaveBeenCalledExactlyOnceWith({
      sessionID: session.id,
      messageID: firstTurn ? null : "canonical-reply",
    });
    expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveAttribute(
        "contenteditable",
        "false",
      ),
    );
    for (const button of screen.getAllByRole("button", {
      name: "Edit message",
    }))
      expect(button).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(rpc.agent.prompt.mutate).toHaveBeenCalledOnce());
    expect(rpc.agent.prompt.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: session.id,
        input: expect.objectContaining({
          parts: [
            {
              type: "context",
              context: { kind: "quote", text: "Quoted context" },
            },
            { type: "text", text: "Changed question" },
          ],
        }),
      }),
    );
    expect(screen.queryByText("Answer to discard")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(`/app/sessions/${session.id}`);
    expect(fixture.sessions).toHaveLength(1);
  },
);

test.each(["truncate", "prompt"])(
  "an edit retains its draft after %s fails and retries only unfinished work",
  async (failure) => {
    const fixture = backend();
    const session = await rpc.agent.createSession.mutate({});
    fixture.messages.set(session.id, [
      { id: "question", role: "user", content: "Original question" },
      { id: "answer", role: "assistant", content: "Old answer" },
    ]);
    const model = {
      providerID: CODEX,
      modelID: TIER2,
      selectedVariant: "high",
    };
    fixture.messageInfo.set(session.id, {
      question: { model, workspaceId: undefined },
    });
    if (failure === "truncate")
      rpc.agent.truncateSession.mutate.mockRejectedValueOnce(
        new Error("Truncation unavailable"),
      );
    else
      rpc.agent.prompt.mutate.mockRejectedValueOnce(
        new Error("Admission unavailable"),
      );
    window.history.replaceState({}, "", `/app/sessions/${session.id}`);
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit message" }),
    );
    const input = screen.getByRole("textbox", { name: "Edit message" });
    await user.clear(input);
    await user.type(input, "Retry this edit");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await findErrorToast()).toHaveTextContent(
      failure === "truncate"
        ? "Truncation unavailable"
        : "Admission unavailable",
    );
    const retryInput = await screen.findByRole("textbox", {
      name: failure === "truncate" ? "Edit message" : "Message",
    });
    await waitFor(() =>
      expect(retryInput).toHaveTextContent("Retry this edit"),
    );
    expect(
      screen.getByRole("combobox", { name: "Other model high" }),
    ).toBeEnabled();
    if (failure === "truncate") {
      expect(screen.getByText("Old answer")).toBeVisible();
      expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
    } else {
      expect(screen.queryByText("Old answer")).not.toBeInTheDocument();
    }
    await user.click(
      screen.getByRole("button", {
        name: failure === "truncate" ? "Send" : "Send message",
      }),
    );
    expect(
      await screen.findByText("Saved answer from the backend."),
    ).toBeVisible();
    expect(rpc.agent.truncateSession.mutate).toHaveBeenCalledTimes(
      failure === "truncate" ? 2 : 1,
    );
    expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(
      failure === "truncate" ? 1 : 2,
    );
    expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          model,
          parts: [{ type: "text", text: "Retry this edit" }],
        }),
      }),
    );
  },
);

test.each(["delegate", "dig_in"])(
  "%s sessions do not offer editing",
  async (kind) => {
    const fixture = backend();
    const session = await rpc.agent.createSession.mutate({});
    Object.assign(session, { kind, parentId: "parent-session" });
    fixture.messages.set(session.id, [
      { id: "question", role: "user", content: "Child input" },
    ]);
    window.history.replaceState({}, "", `/app/sessions/${session.id}`);
    renderWorkspace();
    expect(await screen.findByText("Child input")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit message" }),
    ).not.toBeInTheDocument();
  },
);

test.each(["queued", "running"])(
  "an edit cannot submit while a run is %s",
  async (status) => {
    const fixture = backend();
    const session = await rpc.agent.createSession.mutate({});
    fixture.messages.set(session.id, [
      { id: "question", role: "user", content: "Original input" },
    ]);
    window.history.replaceState({}, "", `/app/sessions/${session.id}`);
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit message" }),
    );
    await act(async () =>
      fixture.emit("agent.event", {
        sessionID: session.id,
        event: {
          type: "STATE_DELTA",
          delta: [
            { op: "add", path: "/runs", value: [{ id: "active-run", status }] },
          ],
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Edit message" }),
      "{enter}",
    );
    expect(rpc.agent.truncateSession.mutate).not.toHaveBeenCalled();
    expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  },
);

test.each(["page", "copilot"] as const)(
  "%s Tea mentions persist directives, discover files on demand, and retain failed draft pills",
  async (host) => {
    backend();
    let entries = [
      { path: "strategies/moving average.tea", hash: "a".repeat(64) },
    ];
    rpc.workspace.listTree.query.mockImplementation(async () => ({
      status: "ready",
      directories: [],
      entries,
    }));
    if (host === "copilot")
      window.history.replaceState({}, "", "/app/settings/interface");
    const view = renderWorkspace();
    const user = userEvent.setup();
    if (host === "copilot")
      await user.click(
        await screen.findByRole("button", { name: "Toggle Copilot" }),
      );
    const input = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() =>
      expect(input).toHaveAttribute("contenteditable", "true"),
    );
    await user.type(input, "Explain @moving");
    await screen.findByRole("option", {
      name: "strategies/moving average.tea",
    });
    await user.keyboard("{Enter}");
    const first =
      "Explain :file[strategies/moving average.tea]{name=/workspaces/wsp_default/strategies/moving average.tea}";
    expect(input).toHaveTextContent("Explain strategies/moving average.tea");
    expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();

    entries = [{ path: "fresh.tea", hash: "b".repeat(64) }];
    await user.keyboard(" @fresh");
    await user.click(await screen.findByRole("option", { name: "fresh.tea" }));
    const text = `${first} :file[fresh.tea]{name=/workspaces/wsp_default/fresh.tea}`;
    const visible = "Explain strategies/moving average.tea fresh.tea";
    expect(input).toHaveTextContent(visible);
    rpc.agent.prompt.mutate.mockRejectedValueOnce(
      new Error("Try sending again"),
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).toHaveTextContent(visible),
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Saved answer from the backend.");
    expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: {
          agent: "analyst",
          workspaceId: "wsp_default",
          model: { providerID: CODEX, modelID: TIER1 },
          parts: [{ type: "text", text }],
        },
      }),
    );
    const path = "/workspaces/wsp_default/strategies/moving average.tea";
    expect(
      screen.getByLabelText("file: strategies/moving average.tea"),
    ).toHaveAttribute("data-directive-id", path);
    // Simulate a refresh: a new runtime must reconstruct chips from saved text.
    view.unmount();
    window.history.replaceState({}, "", "/app/sessions/ses_1");
    renderWorkspace();
    expect(
      await screen.findByLabelText("file: strategies/moving average.tea"),
    ).toHaveAttribute("data-directive-id", path);
    await user.click(
      await screen.findByRole("button", { name: "Edit message" }),
    );
    const editor = screen.getByRole("textbox", { name: "Edit message" });
    expect(
      await within(editor).findByLabelText(
        "file: strategies/moving average.tea",
      ),
    ).toHaveAttribute("data-directive-id", path);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(rpc.agent.prompt.mutate).toHaveBeenCalledTimes(3),
    );
    expect(rpc.agent.prompt.mutate.mock.lastCall?.[0].input.parts).toEqual([
      { type: "text", text },
    ]);
    expect(rpc.workspace.read.query).not.toHaveBeenCalled();
  },
);

test("Tea mentions search relative paths without matching the workspace root", async () => {
  backend();
  rpc.workspace.listTree.query.mockResolvedValue({
    status: "ready",
    directories: [],
    entries: [
      { path: "examples/AAPL-daily.tea", hash: "a".repeat(64) },
      { path: "hello-agent.tea", hash: "b".repeat(64) },
      { path: "hello-world.tea", hash: "c".repeat(64) },
    ],
  });
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "@WOR");
  await waitFor(() =>
    expect(
      screen.getAllByRole("option").map((item) => item.textContent),
    ).toEqual(["hello-world.tea"]),
  );
  await user.keyboard("{Enter}");
  expect(input).toHaveTextContent("hello-world.tea");

  await user.clear(input);
  await user.type(input, "@examples/");
  await waitFor(() =>
    expect(
      screen.getAllByRole("option").map((item) => item.textContent),
    ).toEqual(["examples/AAPL-daily.tea"]),
  );
  await user.clear(input);
  await user.type(input, "@workspaces");
  await screen.findByText("No matching files.");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
});

test("Tea mentions and submission restore the conversation workspace", async () => {
  const fixture = backend();
  const session = await rpc.agent.createSession.mutate({});
  fixture.messages.set(session.id, [
    { id: "question", role: "user", content: "Earlier question" },
  ]);
  fixture.messageInfo.set(session.id, {
    question: {
      model: { providerID: CODEX, modelID: TIER1 },
      workspaceId: "wsp_research",
    },
  });
  rpc.workspace.listTree.query.mockImplementation(
    async ({ workspaceId }: { workspaceId: string }) => ({
      status: "ready",
      directories: [],
      entries: [{ path: `${workspaceId}.tea`, hash: "a".repeat(64) }],
    }),
  );
  window.history.replaceState({}, "", `/app/sessions/${session.id}`);
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  expect(
    await screen.findByRole("button", { name: "Workspace: wsp_research" }),
  ).toBeVisible();
  await user.type(input, "Review @");
  await user.click(
    await screen.findByRole("option", { name: "wsp_research.tea" }),
  );
  expect(
    screen.queryByRole("option", { name: "wsp_default.tea" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Saved answer from the backend.");
  expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        workspaceId: "wsp_research",
        parts: [
          {
            type: "text",
            text: "Review :file[wsp_research.tea]{name=/workspaces/wsp_research/wsp_research.tea}",
          },
        ],
      }),
    }),
  );
});

test.each(["page", "copilot"] as const)(
  "%s workspace picker keeps the draft and uses its selection for mentions, retry and history",
  async (host) => {
    backend();
    const root = "/workspaces/a-very-long-research-workspace-name/";
    rpc.resources.workspace.list.query.mockResolvedValue({
      items: [
        { id: "wsp_default", root: "/workspaces/wsp_default" },
        { id: "wsp_research", root },
        { id: "wsp_other", root: "/other/a-very-long-research-workspace-name" },
      ],
      nextCursor: null,
    });
    rpc.resources.workspace.get.query.mockImplementation(
      async ({ id }: { id: string }) => ({
        id,
        root: id === "wsp_research" ? root : `/workspaces/${id}`,
      }),
    );
    rpc.workspace.listTree.query.mockImplementation(
      async ({ workspaceId }: { workspaceId: string }) => ({
        status: "ready",
        directories: [],
        entries: [{ path: `${workspaceId}.tea`, hash: "a".repeat(64) }],
      }),
    );
    if (host === "copilot")
      window.history.replaceState({}, "", "/app/settings/interface");
    const view = renderWorkspace();
    const user = userEvent.setup();
    if (host === "copilot")
      await user.click(
        await screen.findByRole("button", { name: "Toggle Copilot" }),
      );
    const input = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() =>
      expect(input).toHaveAttribute("contenteditable", "true"),
    );
    await user.type(input, "Review ");
    await user.click(
      await screen.findByRole("button", { name: "Workspace: wsp_default" }),
    );
    expect(
      await screen.findByRole("menuitemradio", {
        name: "wsp_default",
      }),
    ).toBeChecked();
    const choices = screen.getAllByRole("menuitemradio", {
      name: "a-very-long-research-workspace-name",
    });
    expect(choices).toHaveLength(2);
    await user.click(choices[0]!);
    const picker = await screen.findByRole("button", {
      name: "Workspace: a-very-long-research-workspace-name",
    });
    expect(picker).toHaveAttribute("title", root);
    expect(picker).toHaveTextContent(/^a-very-long-research-workspace-name$/);
    expect(input).toHaveTextContent("Review");
    expect(rpc.agent.createSession.mutate).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "Review @");
    await user.click(
      await screen.findByRole("option", { name: "wsp_research.tea" }),
    );
    expect(
      screen.queryByRole("option", { name: "wsp_default.tea" }),
    ).not.toBeInTheDocument();
    rpc.agent.prompt.mutate.mockRejectedValueOnce(
      new Error("Retry workspace selection"),
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).toHaveTextContent("Review wsp_research.tea"),
    );
    expect(
      screen.getByRole("button", {
        name: "Workspace: a-very-long-research-workspace-name",
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText("Saved answer from the backend.");
    expect(rpc.agent.prompt.mutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          workspaceId: "wsp_research",
          parts: [
            {
              type: "text",
              text: `Review :file[wsp_research.tea]{name=${root}wsp_research.tea}`,
            },
          ],
        }),
      }),
    );
    view.unmount();
    window.history.replaceState({}, "", "/app/sessions/ses_1");
    renderWorkspace();
    expect(
      await screen.findByRole("button", {
        name: "Workspace: a-very-long-research-workspace-name",
      }),
    ).toBeVisible();
    expect(rpc.workspace.read.query).not.toHaveBeenCalled();
  },
);

test("workspace picker retries registry failures and displays an empty registry", async () => {
  backend();
  // Stay offline through startup/SSE refreshes until the explicit retry below.
  rpc.resources.workspace.list.query.mockRejectedValue(new Error("Offline"));
  renderWorkspace();
  const user = userEvent.setup();
  const picker = await screen.findByRole("button", {
    name: "Workspace: wsp_default",
  });
  await user.click(picker);
  expect(await screen.findByText("Couldn’t load workspaces")).toBeVisible();
  rpc.resources.workspace.list.query.mockResolvedValue({
    items: [],
    nextCursor: null,
  });
  await user.click(screen.getByRole("menuitem", { name: "Try again" }));
  await user.click(picker);
  expect(
    await screen.findByRole("menuitem", { name: "No registered workspaces." }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(picker).toHaveTextContent("wsp_default");
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
});

test("slash completion uses the backend catalog, official menu, and only the leading position", async () => {
  backend();
  rpc.agent.commands.query.mockResolvedValue([
    {
      name: "research",
      type: "workflow",
      description: "Custom server workflow",
      hints: ["$1"],
    },
    {
      name: "shrink",
      type: "compaction",
      description: "Custom server compaction",
      hints: [],
    },
  ]);
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "/");
  await screen.findByRole("option", { name: /\/research/ });
  expect(screen.getByRole("option", { name: /\/shrink/ })).toBeInTheDocument();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(input).toHaveTextContent("/shrink");
  expect(within(input).getByLabelText("command: /shrink")).toHaveAttribute(
    "data-directive-id",
    "shrink",
  );
  expect(rpc.agent.buildCommand.mutate).not.toHaveBeenCalled();
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  await user.keyboard("more /research");
  expect(input).toHaveTextContent("more /research");
  expect(
    screen.queryByRole("listbox", { name: "Commands" }),
  ).not.toBeInTheDocument();
  await user.clear(input);
  await user.type(input, "First research /sh");
  expect(
    screen.queryByRole("listbox", { name: "Commands" }),
  ).not.toBeInTheDocument();
  await user.clear(input);
  await user.type(input, "/res");
  await user.click(await screen.findByRole("option", { name: /\/research/ }));
  expect(input).toHaveTextContent("/research");
  expect(
    within(input).getByLabelText("command: /research"),
  ).toBeInTheDocument();
  await user.keyboard("{Backspace}{Backspace}");
  expect(
    within(input).queryByLabelText("command: /research"),
  ).not.toBeInTheDocument();
  expect(input).toHaveTextContent(/^$/);
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
});

test("command construction precedes prompt and failures preserve the draft for retry", async () => {
  backend();
  const parts = [
    {
      type: "workflow",
      workflow: "default:workflows/best-of-n.workflow.ts",
      args: { n: 3, question: "Google /compact" },
    },
  ];
  rpc.agent.buildCommand.mutate.mockRejectedValueOnce(
    new Error("Could not build command"),
  );
  let resolveBuild!: (parts: unknown) => void;
  rpc.agent.buildCommand.mutate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveBuild = resolve;
      }),
  );
  rpc.agent.prompt.mutate.mockResolvedValue({
    id: "agr_command",
    status: "pending",
  });
  renderWorkspace();
  const user = userEvent.setup();
  const input = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect(input).toHaveAttribute("contenteditable", "true"));
  await user.type(input, "/best");
  await user.click(await screen.findByRole("option", { name: /\/best-of-n/ }));
  await user.keyboard("3 Google /compact");
  expect(input).toHaveTextContent("3 Google /compact");
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce(),
  );
  await waitFor(() =>
    expect(rpc.agent.buildCommand.mutate).toHaveBeenCalledOnce(),
  );
  await screen.findByText("Could not build command");
  const restored = screen.getByRole("textbox", { name: "Message" });
  await waitFor(() => expect(restored).toHaveTextContent("3 Google /compact"));
  expect(
    within(restored).getByLabelText("command: /best-of-n"),
  ).toHaveAttribute("data-directive-id", "best-of-n");
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() =>
    expect(rpc.agent.buildCommand.mutate).toHaveBeenCalledTimes(2),
  );
  expect(rpc.agent.buildCommand.mutate).toHaveBeenLastCalledWith({
    command: "best-of-n",
    arguments: "3 Google /compact",
  });
  expect(rpc.agent.prompt.mutate).not.toHaveBeenCalled();
  await act(async () => resolveBuild(parts));
  await waitFor(() =>
    expect(rpc.agent.prompt.mutate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: expect.objectContaining({ parts }) }),
    ),
  );
  expect(rpc.agent.createSession.mutate).toHaveBeenCalledOnce();
});

test.each(["page", "copilot"] as const)(
  "%s compact includes available page context",
  async (host) => {
    backend();
    rpc.agent.buildCommand.mutate.mockResolvedValue([
      { type: "compaction", auto: false },
    ]);
    rpc.agent.prompt.mutate.mockResolvedValue({
      id: "agr_compact",
      status: "pending",
    });
    if (host === "copilot")
      window.history.replaceState({}, "", "/app/workspaces");
    renderWorkspace();
    const user = userEvent.setup();
    if (host === "copilot")
      await user.click(
        await screen.findByRole("button", { name: "Toggle Copilot" }),
      );
    const input = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() =>
      expect(input).toHaveAttribute("contenteditable", "true"),
    );
    await user.type(input, "/compact");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(rpc.agent.prompt.mutate).toHaveBeenCalledOnce());
    expect(rpc.agent.buildCommand.mutate).toHaveBeenCalledExactlyOnceWith({
      command: "compact",
      arguments: "",
    });
    expect(rpc.agent.prompt.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          parts: [
            { type: "compaction", auto: false },
            ...(host === "copilot"
              ? [
                  {
                    type: "text",
                    synthetic: true,
                    text: expect.stringContaining(
                      '{"view":"workspace","file":null}',
                    ),
                  },
                ]
              : []),
          ],
        }),
      }),
    );
  },
);
