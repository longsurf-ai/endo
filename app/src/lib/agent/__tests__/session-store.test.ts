import { QueryClient } from "@tanstack/react-query";
// Purpose: Checks shared observation, reconnect snapshots, and native reducer/converter interoperability.

import { CODEX } from "@openchart/models/model-tiers";

import { EventType, type AGUIEvent, type Message } from "@ag-ui/core";
import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";
import { Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentClient,
  SessionState,
  TranscriptPage,
} from "@openchart/app/lib/agent/client";
import { createSessionStore } from "@openchart/app/lib/agent/session-store";

function state(id: string): SessionState {
  return {
    session: {
      id: id as SessionState["session"]["id"],
      title: id,
      parentId: null,
      kind: "chat",
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
    messageInfo: {},
    history: { nextCursor: null },
  };
}

const disposals: Array<() => void> = [];
afterEach(() => disposals.splice(0).forEach((dispose) => dispose()));

function setup() {
  const streams = new Map<string, Subject<AGUIEvent>>();
  const remote = {
    transport: { url: "test" },
    readTranscriptPage: vi.fn<AgentClient["readTranscriptPage"]>(),
    observe: vi.fn((id: string) => {
      const events = new Subject<AGUIEvent>();
      streams.set(id, events);
      return events;
    }),
    prompt: vi.fn<AgentClient["prompt"]>(),
    renameSession: vi.fn<AgentClient["renameSession"]>(),
    cancel: vi.fn<AgentClient["cancel"]>(),
    replyQuestion: vi.fn(),
    replyPermission: vi.fn<AgentClient["replyPermission"]>(),
  };
  const store = createSessionStore(
    remote,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  disposals.push(store.dispose);
  function send(id: string, ...events: AGUIEvent[]) {
    const stream = streams.get(id);
    if (!stream) throw new Error(`No subscription for ${id}`);
    events.forEach((event) => stream.next(event));
  }
  return { store, remote, send, streams };
}

describe("shared transcript pagination", () => {
  const message = (n: number): Extract<Message, { role: "user" }> => ({
    id: `msg_${n}`,
    role: "user",
    content: `Turn ${n}`,
  });
  const page = (
    messages: Message[],
    nextCursor: string | null,
  ): TranscriptPage => ({
    messages,
    nextCursor,
    messageInfo: {},
    lifecycle: [],
    open: [],
  });
  const bootstrap = (
    send: ReturnType<typeof setup>["send"],
    messages: Message[],
    nextCursor: string | null,
    kind: SessionState["session"]["kind"] = "chat",
  ) => {
    const snapshot = state("ses_pages");
    snapshot.session.kind = kind;
    snapshot.history.nextCursor = nextCursor;
    send(
      "ses_pages",
      { type: EventType.MESSAGES_SNAPSHOT, messages },
      { type: EventType.STATE_SNAPSHOT, snapshot },
    );
  };

  it.each(["chat", "dig_in", "delegate", "scheduled"] as const)(
    "loads every turn for %s at any page size and continues streaming",
    async (kind) => {
      for (const size of [1, 2, 7, 101, Number.MAX_SAFE_INTEGER]) {
        const { store, remote, send } = setup();
        const all = Array.from({ length: 15 }, (_, n) => message(n));
        remote.readTranscriptPage.mockImplementation(async ({ cursor }) => {
          const end = Number(cursor);
          const start = Math.max(0, end - size);
          return page(all.slice(start, end), start > 0 ? String(start) : null);
        });
        const session = store.getSession("ses_pages");
        session.subscribe(vi.fn());
        const start = Math.max(0, all.length - size);
        bootstrap(
          send,
          all.slice(start),
          start > 0 ? String(start) : null,
          kind,
        );
        await vi.waitFor(() =>
          expect(session.getSnapshot().loading).toBe(false),
        );
        while (session.getSnapshot().history.hasMore) await session.loadOlder();
        expect(session.getSnapshot().messages).toEqual(all);
        expect(remote.readTranscriptPage).toHaveBeenCalledTimes(
          Math.ceil(all.length / size) - 1,
        );
        await session.loadOlder();
        send(
          "ses_pages",
          {
            type: EventType.RUN_STARTED,
            threadId: "ses_pages",
            runId: "run_live",
          },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "answer",
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta: "Live answer",
          },
        );
        await vi.waitFor(() =>
          expect(session.getSnapshot().messages.at(-1)?.content).toBe(
            "Live answer",
          ),
        );
        expect(session.getSnapshot().messages.slice(0, -1)).toEqual(all);
        store.dispose();
      }
    },
  );

  it("cancels obsolete pages even when a snapshot has the same cursor", async () => {
    const { store, remote, send } = setup();
    let finish!: (value: TranscriptPage) => void;
    let signal: AbortSignal | undefined;
    remote.readTranscriptPage.mockImplementationOnce((_input, request) => {
      signal = request?.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const session = store.getSession("ses_pages");
    session.subscribe(vi.fn());
    bootstrap(send, [message(2)], "2");
    await vi.waitFor(() =>
      expect(session.getSnapshot().history.hasMore).toBe(true),
    );
    const pending = session.loadOlder();
    await session.loadOlder();
    expect(remote.readTranscriptPage).toHaveBeenCalledTimes(1);
    bootstrap(send, [{ ...message(2), content: "Reconnected" }], "2");
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    finish(page([message(0)], null));
    await pending;
    expect(session.getSnapshot().messages.map((m) => m.content)).toEqual([
      "Reconnected",
    ]);
    remote.readTranscriptPage.mockResolvedValueOnce(page([message(1)], null));
    await session.loadOlder();
    expect(session.getSnapshot().messages.map((m) => m.content)).toEqual([
      "Turn 1",
      "Reconnected",
    ]);
    expect(session.getSnapshot().history.hasMore).toBe(false);
  });

  it("keeps live history after a page failure and retries the same boundary", async () => {
    const { store, remote, send } = setup();
    remote.readTranscriptPage.mockRejectedValueOnce(new Error("Offline"));
    const session = store.getSession("ses_pages");
    session.subscribe(vi.fn());
    bootstrap(send, [message(2)], "2");
    await vi.waitFor(() =>
      expect(session.getSnapshot().history.hasMore).toBe(true),
    );
    await session.loadOlder();
    expect(session.getSnapshot().history).toEqual({
      hasMore: true,
      loading: false,
      error: "Offline",
    });
    expect(session.getSnapshot().messages).toEqual([message(2)]);
    remote.readTranscriptPage.mockResolvedValueOnce(page([message(1)], null));
    await session.loadOlder();
    expect(session.getSnapshot().history).toEqual({
      hasMore: false,
      loading: false,
      error: undefined,
    });
    expect(
      remote.readTranscriptPage.mock.calls.map(([input]) => input.cursor),
    ).toEqual(["2", "2"]);
  });

  it("releases older pages after the last detach and loads a fresh boundary on reopen", async () => {
    const { store, remote, send } = setup();
    remote.readTranscriptPage.mockResolvedValue(page([message(1)], null));
    const session = store.getSession("ses_pages");
    const stop = session.subscribe(vi.fn());
    bootstrap(send, [message(2)], "2");
    await vi.waitFor(() =>
      expect(session.getSnapshot().history.hasMore).toBe(true),
    );
    await session.loadOlder();
    expect(session.getSnapshot().messages).toHaveLength(2);
    stop();
    expect(session.getSnapshot().messages).toEqual([message(2)]);
    session.subscribe(vi.fn());
    bootstrap(send, [message(3)], "3");
    await vi.waitFor(() =>
      expect(session.getSnapshot().history.hasMore).toBe(true),
    );
    await session.loadOlder();
    expect(
      remote.readTranscriptPage.mock.calls.map(([input]) => input.cursor),
    ).toEqual(["2", "3"]);
  });

  it("restores historical headers and delegate cards while live overlapping content wins", async () => {
    const { store, remote, send } = setup();
    const historical = page(
      [message(0), { ...message(2), content: "Stale" }],
      null,
    );
    historical.messageInfo.msg_0 = {
      model: { providerID: "codex", modelID: "old-model" },
      workspaceId: undefined,
    };
    historical.messageInfo.msg_2 = {
      model: { providerID: "codex", modelID: "stale-model" },
      workspaceId: undefined,
    };
    historical.lifecycle = [
      {
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: "old_child",
        name: "Historical delegate",
        parentMessageId: "msg_0",
      },
      { type: EventType.SUBAGENT_FINISHED, subagentRunId: "old_child" },
    ];
    const before = structuredClone(historical);
    remote.readTranscriptPage.mockResolvedValue(historical);
    const session = store.getSession("ses_pages");
    session.subscribe(vi.fn());
    bootstrap(send, [message(2)], "2");
    send("ses_pages", {
      type: EventType.STATE_DELTA,
      delta: [
        {
          op: "add",
          path: "/messageInfo/msg_2",
          value: { model: { providerID: "codex", modelID: "live-model" } },
        },
      ],
    });
    await vi.waitFor(() =>
      expect(session.getSnapshot().history.hasMore).toBe(true),
    );
    await session.loadOlder();
    const snapshot = session.getSnapshot();
    expect(snapshot.messages.map((m) => m.content)).toEqual([
      "Turn 0",
      "Turn 2",
    ]);
    expect(snapshot.state?.messageInfo.msg_0?.model?.modelID).toBe("old-model");
    expect(snapshot.state?.messageInfo.msg_2?.model?.modelID).toBe(
      "live-model",
    );
    expect(snapshot.subagents.old_child?.end?.type).toBe(
      EventType.SUBAGENT_FINISHED,
    );
    expect(snapshot.state?.runs).toEqual([]);
    expect(remote.prompt).not.toHaveBeenCalled();
    expect(historical).toEqual(before);
  });
});

describe("shared community session state", () => {
  it("hydrates idle sessions and shares one observer across independent subscribers", async () => {
    const { store, remote, send } = setup();
    const first = store.getSession("ses_first");
    const same = store.getSession("ses_first");
    const other = store.getSession("ses_other");
    const stopFirst = first.subscribe(vi.fn());
    same.subscribe(vi.fn());
    other.subscribe(vi.fn());
    send(
      "ses_first",
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "msg_old", role: "assistant", content: "Saved answer" },
        ],
      },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_first") },
    );
    send(
      "ses_other",
      { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_other") },
    );
    await vi.waitFor(() => expect(first.getSnapshot().loading).toBe(false));
    expect(first).toBe(same);
    expect(remote.observe).toHaveBeenCalledTimes(2);
    expect(first.getSnapshot().messages[0]?.content).toBe("Saved answer");
    expect(other.getSnapshot().messages).toEqual([]);
    stopFirst();
    send(
      "ses_first",
      { type: EventType.RUN_STARTED, threadId: "ses_first", runId: "agr_next" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg_next",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg_next",
        delta: "Still observed",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_next" },
      {
        type: EventType.RUN_FINISHED,
        threadId: "ses_first",
        runId: "agr_next",
      },
    );
    await vi.waitFor(() =>
      expect(same.getSnapshot().messages.at(-1)?.content).toBe(
        "Still observed",
      ),
    );
    expect(remote.cancel).not.toHaveBeenCalled();
  });

  it("replaces missed history on reconnect and appends active text without duplication", async () => {
    const { store, send } = setup();
    const session = store.getSession("ses_live");
    session.subscribe(vi.fn());
    send(
      "ses_live",
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "msg_live", role: "assistant", content: "Hello" }],
      },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_live") },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg_live",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg_live",
        delta: " world",
      },
    );
    await vi.waitFor(() =>
      expect(session.getSnapshot().messages[0]?.content).toBe("Hello world"),
    );
    send(
      "ses_live",
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "msg_live",
            role: "assistant",
            content: "Hello world; recovered",
          },
        ],
      },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_live") },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg_live",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg_live",
        delta: "!",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "msg_live" },
    );
    await vi.waitFor(() =>
      expect(session.getSnapshot().messages[0]?.content).toBe(
        "Hello world; recovered!",
      ),
    );
    expect(session.getSnapshot().messages).toHaveLength(1);
  });

  it("disconnects the last listener and reopens the same handle with a fresh snapshot", async () => {
    const { store, remote, send, streams } = setup();
    const session = store.getSession("ses_reopen");
    const stop = session.subscribe(vi.fn());
    const firstTransport = streams.get("ses_reopen");
    send(
      "ses_reopen",
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "msg_reopen", role: "assistant", content: "Before close" },
        ],
      },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_reopen") },
    );
    await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false));
    stop();
    expect(firstTransport?.observed).toBe(false);
    expect(remote.cancel).not.toHaveBeenCalled();
    expect(store.getSession("ses_reopen")).toBe(session);
    expect(session.getSnapshot().loading).toBe(true);
    session.subscribe(vi.fn());
    expect(remote.observe).toHaveBeenCalledTimes(2);
    send(
      "ses_reopen",
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "msg_reopen",
            role: "assistant",
            content: "Completed while closed",
          },
        ],
      },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_reopen") },
    );
    await vi.waitFor(() =>
      expect(session.getSnapshot().messages[0]?.content).toBe(
        "Completed while closed",
      ),
    );
    expect(session.getSnapshot().loading).toBe(false);
  });

  it("replaces cached order and removes stale activities on authoritative snapshots", async () => {
    const { store, send } = setup();
    const session = store.getSession("ses_gap");
    const call: Message = {
      id: "call",
      role: "assistant",
      toolCalls: [
        {
          id: "tool",
          type: "function",
          function: { name: "echo", arguments: "{}" },
        },
      ],
    };
    const activity: Message = {
      id: "activity",
      role: "activity",
      activityType: "openchart.tool",
      content: { toolCallId: "tool", status: "running" },
    };
    const stop = session.subscribe(vi.fn());
    send(
      "ses_gap",
      { type: EventType.MESSAGES_SNAPSHOT, messages: [call, activity] },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_gap") },
    );
    await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false));
    stop();
    session.subscribe(vi.fn());
    const complete: Message[] = [
      call,
      { id: "result", role: "tool", toolCallId: "tool", content: "done" },
      { ...activity, content: { toolCallId: "tool", status: "completed" } },
    ];
    send(
      "ses_gap",
      { type: EventType.MESSAGES_SNAPSHOT, messages: complete },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_gap") },
    );
    await vi.waitFor(() =>
      expect(session.getSnapshot().messages).toEqual(complete),
    );
    send("ses_gap", { type: EventType.MESSAGES_SNAPSHOT, messages: [] });
    await vi.waitFor(() => expect(session.getSnapshot().messages).toEqual([]));
  });

  it("reduces tool calls and permission state with the public libraries", async () => {
    const { store, send, remote } = setup();
    const session = store.getSession("ses_tools");
    session.subscribe(vi.fn());
    send(
      "ses_tools",
      { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
      { type: EventType.STATE_SNAPSHOT, snapshot: state("ses_tools") },
      { type: EventType.RUN_STARTED, threadId: "ses_tools", runId: "agr_tool" },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call_echo",
        toolCallName: "Echo",
        parentMessageId: "msg_tool",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call_echo",
        delta: '{"text":"approved"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "call_echo" },
      {
        type: EventType.STATE_DELTA,
        delta: [
          {
            op: "add",
            path: "/permissions",
            value: [
              {
                id: "per_echo",
                sessionID: "ses_tools",
                action: "Echo",
                resources: ["approved"],
              },
            ],
          },
        ],
      },
    );
    await vi.waitFor(() =>
      expect(session.getSnapshot().state?.permissions).toHaveLength(1),
    );
    await session.replyPermission("per_echo", "once");
    expect(remote.replyPermission).toHaveBeenCalledWith("per_echo", "once");
    send(
      "ses_tools",
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/permissions", value: [] }],
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "msg_result",
        toolCallId: "call_echo",
        content: "approved",
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "ses_tools",
        runId: "agr_tool",
      },
    );
    await vi.waitFor(() =>
      expect(session.getSnapshot().messages).toHaveLength(2),
    );
    const rendered = fromAgUiMessages(session.getSnapshot().messages);
    expect(rendered[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolName: "Echo",
          result: "approved",
        }),
      ]),
    );
  });

  it("rejects command failures without replacing execution failures, and disposes observation", async () => {
    const { store, remote, streams, send } = setup();
    const session = store.getSession("ses_error");
    session.subscribe(vi.fn());
    send("ses_error", {
      type: EventType.RUN_ERROR,
      message: "Recorded model failure",
    });
    remote.prompt.mockRejectedValue(new Error("Admission unavailable"));
    await expect(
      session.submit(
        [
          { type: "context", context: { kind: "quote", text: "Quoted reply" } },
          { type: "text", text: "Hello" },
        ],
        { providerID: CODEX, modelID: "tier1" },
      ),
    ).rejects.toThrow("Admission unavailable");
    expect(remote.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "ses_error",
        input: {
          agent: "analyst",
          model: { providerID: CODEX, modelID: "tier1" },
          parts: [
            {
              type: "context",
              context: { kind: "quote", text: "Quoted reply" },
            },
            { type: "text", text: "Hello" },
          ],
        },
      }),
    );
    expect(session.getSnapshot().error).toBe("Recorded model failure");
    expect(streams.get("ses_error")?.observed).toBe(true);
    store.dispose();
    expect(streams.get("ses_error")?.observed).toBe(false);
  });
});
