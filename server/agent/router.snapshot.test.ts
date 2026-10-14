import { DEFAULT_HISTORY_TURN_LIMIT } from "@openchart/server/agent/session/operations/read-transcript-page";
// Purpose: Verifies session-scoped SSE snapshot ordering, reconnect, and cleanup over real HTTP.

import { CLAUDE_CODE, CODEX } from "@openchart/models/model-tiers";

import { temporaryHome } from "@openchart/server/home.test-utils";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { createAgentClient } from "@openchart/app/lib/agent/client";
import { createSessionStore } from "@openchart/app/lib/agent/session-store";
import { createTransport } from "@openchart/app/lib/transport/transport";
import {
  sessionsQueryOptions,
  subscribeQueryInvalidation,
} from "@openchart/app/lib/agent/queries";
import { QueryClient, InfiniteQueryObserver } from "@tanstack/react-query";
import { createRequestHandler } from "@openchart/server";
import { Session } from "@openchart/server/agent/session";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import type { Assistant } from "@openchart/server/agent/contracts/message";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import { makeRuntime } from "@openchart/server/runtime";
import { Events } from "@openchart/server/events";
import { ResourceChanged } from "@openchart/server/lib/resource/events";
import { EventSource } from "eventsource";
import { afterEach, expect, test } from "vitest";

const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function fixture(
  intercept = (
    _request: IncomingMessage,
    _response: ServerResponse,
    next: () => void,
  ) => next(),
) {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  const handle = createRequestHandler(runtime);
  const connections = { opened: 0, active: new Set<ServerResponse>() };
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/trpc/events.subscribe")) {
      connections.opened++;
      connections.active.add(response);
      response.on("close", () => connections.active.delete(response));
    }
    intercept(request, response, () => handle(request, response));
  });
  disposals.push(async () => {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    await runtime.dispose();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP port");
  const remote = createAgentClient(
    createTransport(
      { origin: `http://127.0.0.1:${address.port}` },
      { EventSource },
    ),
  );
  const sessions = await runtime.runPromise(Session.Service);
  const events = await runtime.runPromise(Events.Service);
  const frames: unknown[] = [];
  const snapshots: unknown[] = [];
  const stream = remote.events.subscribe((frame) => {
    frames.push(frame);
    if (frame.kind === "event" && frame.event.type === "agent.snapshot")
      snapshots.push(frame.event.data);
  });
  disposals.push(() => stream.unsubscribe());
  await expect.poll(() => frames).toContainEqual({ kind: "ready" });

  function observe(sessionID: string) {
    const received: AGUIEvent[] = [];
    const errors: unknown[] = [];
    const observer = remote.observe(sessionID).subscribe({
      next: (event) => received.push(event),
      error: (error) => errors.push(error),
    });
    disposals.push(() => observer.unsubscribe());
    return { received, errors, close: () => observer.unsubscribe() };
  }

  return {
    runtime,
    remote,
    sessions,
    events,
    frames,
    snapshots,
    stream,
    connections,
    observe,
  };
}

async function addTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionID: string,
  index: number,
  streaming = false,
) {
  const id = `msg_${index.toString().padStart(3, "0")}`;
  await f.runtime.runPromise(
    f.sessions.createMessage({
      info: {
        id,
        sessionID,
        role: "user",
        agent: "analyst",
        model: { providerID: CODEX, modelID: "tier1" },
        time: { created: index },
      },
      parts: [
        {
          id: `${id}_input`,
          messageID: id,
          type: "text",
          text: `Question ${index}`,
        },
      ],
    }),
  );
  const assistant: Assistant = {
    id: `${id}_assistant`,
    sessionID,
    role: "assistant",
    triggeringUserMessageID: id,
    agent: "analyst",
    providerID: CODEX,
    modelID: "tier1",
    path: { cwd: "/test", root: "/test" },
    time: { created: index, completed: index + 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  await f.runtime.runPromise(
    f.sessions.createMessage({
      info: assistant,
      parts: [
        {
          id: `${id}_thinking`,
          messageID: assistant.id,
          type: "reasoning",
          text: `Reason ${index}`,
          time: { start: index, end: index + 1 },
        },
      ],
    }),
  );
  const answer = {
    ...assistant,
    id: `${id}_continuation`,
    time: streaming ? { created: index } : assistant.time,
  };
  const text = {
    id: `${id}_answer`,
    messageID: answer.id,
    type: "text" as const,
    text: `Answer ${index}`,
    time: streaming ? { start: index } : { start: index, end: index + 1 },
  };
  await f.runtime.runPromise(
    f.sessions.createMessage({ info: answer, parts: [text] }),
  );
  return { assistant: answer, text };
}

test("pages whole turns over HTTP while bounded SSE snapshots keep streaming, reconnecting, and replacing history", async () => {
  const held: Array<() => void> = [];
  let holdPages = false;
  const f = await fixture((request, _response, next) => {
    if (holdPages && request.url?.startsWith("/trpc/agent.readTranscriptPage"))
      held.push(next);
    else next();
  });
  const sessionID = (await f.remote.createSession({ title: "Long transcript" }))
    .id;
  f.stream.unsubscribe();
  let latest = await addTurn(f, sessionID, 0);
  for (let index = 1; index < 23; index++)
    latest = await addTurn(f, sessionID, index, index === 22);
  const tool: ToolPart = {
    id: "prt_pending",
    messageID: latest.assistant.id,
    type: "tool",
    tool: "Echo",
    callID: "call_pending",
    childSessionIds: [],
    state: { status: "pending", input: {} },
  };
  await f.runtime.runPromise(f.sessions.createPart(tool));
  const store = createSessionStore(
    f.remote,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  disposals.push(store.dispose);
  const live = store.getSession(sessionID);
  disposals.push(live.subscribe(() => {}));
  await expect.poll(() => live.getSnapshot().loading).toBe(false);
  const users = () =>
    live
      .getSnapshot()
      .messages.filter((message) => message.role === "user")
      .map((message) => message.id);
  const userIDs = Array.from(
    { length: 23 },
    (_, index) => `msg_${index.toString().padStart(3, "0")}`,
  );
  expect(users()).toEqual(userIDs.slice(-DEFAULT_HISTORY_TURN_LIMIT));
  expect(Object.keys(live.getSnapshot().state!.messageInfo)).toHaveLength(
    Math.min(23, DEFAULT_HISTORY_TURN_LIMIT) * 3,
  );
  const cursor = live.getSnapshot().state!.history.nextCursor!;
  const query = f.remote.transport.rpc.agent.readTranscriptPage;
  for (const turnLimit of [1, 2, 7, 101, Number.MAX_SAFE_INTEGER]) {
    let cursor: string | undefined;
    let loaded: string[] = [];
    do {
      const page = await query.query({ sessionID, turnLimit, cursor });
      loaded = [
        ...page.messages.filter((m) => m.role === "user").map((m) => m.id),
        ...loaded,
      ];
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(loaded).toEqual(userIDs);
  }
  const explicitPage = await query.query({ sessionID, turnLimit: 20 });
  const older = await query.query({
    sessionID,
    cursor: explicitPage.nextCursor!,
    turnLimit: 2,
  });
  expect(
    older.messages
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  ).toEqual(["msg_001", "msg_002"]);
  expect(older.messages.map((message) => message.id)).toEqual([
    "msg_001",
    "msg_001_thinking",
    "msg_001_answer",
    "msg_002",
    "msg_002_thinking",
    "msg_002_answer",
  ]);
  expect(Object.keys(older.messageInfo)).toHaveLength(6);

  holdPages = true;
  const pending = query.query({
    sessionID,
    cursor: older.nextCursor!,
    turnLimit: 1,
  });
  await expect.poll(() => held.length).toBe(1);
  await f.runtime.runPromise(
    f.sessions.updatePart({
      ...latest.text,
      text: `${latest.text.text} streamed`,
    }),
  );
  await expect
    .poll(
      () =>
        live
          .getSnapshot()
          .messages.find((message) => message.id === latest.text.id)?.content,
    )
    .toBe("Answer 22 streamed");
  held[0]!();
  const oldest = await pending;
  expect(
    oldest.messages
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  ).toEqual(["msg_000"]);
  expect(oldest.nextCursor).toBeNull();
  expect(users()).toHaveLength(
    Math.min(userIDs.length, DEFAULT_HISTORY_TURN_LIMIT),
  );
  expect(
    live.getSnapshot().messages.find((message) => message.id === latest.text.id)
      ?.content,
  ).toBe("Answer 22 streamed");
  holdPages = false;

  await f.runtime.runPromise(
    f.sessions.updatePart({
      ...tool,
      state: {
        status: "completed",
        input: { value: "echo" },
        title: "Echo",
        metadata: {},
        output: { type: "text", value: "done" },
        time: { start: 1, end: 2 },
        attachments: [
          {
            id: "frame",
            messageID: tool.messageID,
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64,aGVsbG8=",
          },
        ],
      },
    }),
  );
  await expect
    .poll(
      () =>
        live
          .getSnapshot()
          .messages.find((message) => message.id === "prt_pending:result")
          ?.content,
    )
    .toBe("done");
  const reopenedStore = createSessionStore(
    f.remote,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  disposals.push(reopenedStore.dispose);
  const reopened = reopenedStore.getSession(sessionID);
  disposals.push(reopened.subscribe(() => {}));
  await expect.poll(() => reopened.getSnapshot().loading).toBe(false);
  expect(reopened.getSnapshot().messages).toEqual(live.getSnapshot().messages);
  expect(reopened.getSnapshot().state?.history).toEqual({ nextCursor: cursor });
  const tail = await query.query({ sessionID, turnLimit: 1 });
  expect(tail.messages).toContainEqual(
    expect.objectContaining({
      id: "prt_pending:activity",
      content: expect.objectContaining({
        attachments: [expect.objectContaining({ id: "frame" })],
      }),
    }),
  );
  expect(
    tail.messages.filter((message) => message.role === "user"),
  ).toHaveLength(1);

  await f.runtime.runPromise(
    f.sessions.updatePart({
      ...latest.text,
      text: "Answer 22 streamed",
      time: { start: 22, end: 23 },
    }),
  );
  await f.runtime.runPromise(
    f.sessions.updateMessage({
      ...latest.assistant,
      time: { created: 22, completed: 23 },
    }),
  );
  await live.loadOlder();
  await expect
    .poll(() => users().length)
    .toBe(Math.min(userIDs.length, 2 * DEFAULT_HISTORY_TURN_LIMIT));
  await addTurn(f, sessionID, 23);
  userIDs.push("msg_023");
  await expect.poll(() => users().at(-1)).toBe("msg_023");
  // A complete user input appends; loaded older pages and the cursor stay valid.
  expect(users()).toEqual(userIDs.slice(-(2 * DEFAULT_HISTORY_TURN_LIMIT + 1)));
  expect(live.getSnapshot().state!.history.nextCursor).toBe(cursor);
  expect(live.getSnapshot().history.hasMore).toBe(
    userIDs.length > 2 * DEFAULT_HISTORY_TURN_LIMIT + 1,
  );
  expect(
    (
      await f.runtime.runPromise(
        f.sessions.readTranscriptPage({
          sessionID: sessionID,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      )
    ).history,
  ).toHaveLength(24 * 3);
  await f.runtime.runPromise(
    f.sessions.truncate({ sessionID, messageID: latest.assistant.id }),
  );
  await expect.poll(() => users().at(-1)).toBe("msg_022");
  expect(users()).toEqual(
    userIDs.slice(0, -1).slice(-DEFAULT_HISTORY_TURN_LIMIT),
  );
  expect(live.getSnapshot().state!.history.nextCursor).toBe(cursor);
});

test("history query validates limits and scoped cursors, returns empty pages, and emits no events", async () => {
  const f = await fixture();
  const sessionID = (await f.remote.createSession({ title: "Pages" })).id;
  const otherID = (await f.remote.createSession({ title: "Other" })).id;
  const query = f.remote.transport.rpc.agent.readTranscriptPage;
  expect(await query.query({ sessionID })).toEqual({
    messages: [],
    messageInfo: {},
    lifecycle: [],
    open: [],
    nextCursor: null,
  });
  await addTurn(f, sessionID, 0);
  await addTurn(f, sessionID, 1);
  const observer = f.observe(sessionID);
  await expect
    .poll(() =>
      observer.received.some(
        (event) => event.type === EventType.STATE_SNAPSHOT,
      ),
    )
    .toBe(true);
  const count = observer.received.length;
  const page = await query.query({ sessionID, turnLimit: 1 });
  for (const turnLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await expect(query.query({ sessionID, turnLimit })).rejects.toThrow();
  await expect(query.query({ sessionID, cursor: "bad" })).rejects.toThrow();
  await expect(
    query.query({ sessionID: otherID, cursor: page.nextCursor! }),
  ).rejects.toThrow();
  await expect(query.query({ sessionID: "ses_missing" })).rejects.toThrow();
  expect(observer.received).toHaveLength(count);
});

test("Dig In history pages retain visibility after the context marker leaves the page", async () => {
  const f = await fixture();
  f.stream.unsubscribe();
  const parent = await f.remote.createSession({ title: "Source" });
  const child = await f.runtime.runPromise(
    f.sessions.create({ title: "Dig In", parentId: parent.id, kind: "dig_in" }),
  );
  await addTurn(f, child.id, 0);
  const query = f.remote.transport.rpc.agent.readTranscriptPage;
  expect((await query.query({ sessionID: child.id })).messages).toEqual([]);
  await addTurn(f, child.id, 1);
  await f.runtime.runPromise(
    f.sessions.createPart({
      id: "prt_marker",
      messageID: "msg_001",
      type: "context",
      context: { kind: "dig_in", quoteText: "Selected" },
    }),
  );
  for (let index = 2; index <= 22; index++) await addTurn(f, child.id, index);
  const observer = f.observe(child.id);
  await expect
    .poll(() =>
      observer.received.some(
        (event) => event.type === EventType.MESSAGES_SNAPSHOT,
      ),
    )
    .toBe(true);
  const snapshot = observer.received.find(
    (event) => event.type === EventType.MESSAGES_SNAPSHOT,
  )!;
  if (snapshot.type !== EventType.MESSAGES_SNAPSHOT)
    throw new Error("Expected snapshot");
  expect(
    snapshot.messages.filter((message) => message.role === "user"),
  ).toHaveLength(Math.min(22, DEFAULT_HISTORY_TURN_LIMIT));
  expect(snapshot.messages[0]?.id).toBe(
    `msg_${Math.max(1, 23 - DEFAULT_HISTORY_TURN_LIMIT)
      .toString()
      .padStart(3, "0")}`,
  );
  let page = await query.query({ sessionID: child.id, turnLimit: 21 });
  expect(page.messages[0]?.id).toBe("msg_002");
  page = await query.query({
    sessionID: child.id,
    cursor: page.nextCursor!,
    turnLimit: 21,
  });
  expect(page.messages.map((message) => message.id)).toEqual([
    "msg_001",
    "msg_001_thinking",
    "msg_001_answer",
  ]);
  expect(page.nextCursor).toBeNull();
  expect(
    (
      await f.runtime.runPromise(
        f.sessions.listMessages({
          sessionID: child.id,
          limit: Number.MAX_SAFE_INTEGER,
        }),
      )
    ).items,
  ).toHaveLength(23 * 3);
});

test("restores each Session's saved User models through live and reopened snapshots", async () => {
  const f = await fixture();
  const first = await f.remote.createSession({ title: "First" });
  const other = await f.remote.createSession({ title: "Other" });
  const store = createSessionStore(
    f.remote,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  disposals.push(store.dispose);
  const session = store.getSession(first.id);
  const stop = session.subscribe(() => {});
  disposals.push(stop);
  await expect.poll(() => session.getSnapshot().loading).toBe(false);
  const models = [
    { providerID: CODEX, modelID: "first-model" },
    {
      providerID: CLAUDE_CODE,
      modelID: "second-model",
      selectedVariant: "high",
    },
  ];
  for (const [index, model] of models.entries()) {
    await f.runtime.runPromise(
      f.sessions.createMessage({
        info: {
          id: `msg_model_${index}`,
          sessionID: first.id,
          role: "user",
          agent: "analyst",
          model,
          time: { created: index + 1 },
        },
        parts: [
          {
            id: `prt_model_${index}`,
            messageID: `msg_model_${index}`,
            type: "text",
            text: `Turn ${index}`,
          },
        ],
      }),
    );
    await expect
      .poll(
        () =>
          session.getSnapshot().state?.messageInfo[`msg_model_${index}`]?.model,
      )
      .toEqual(model);
  }
  expect(
    (
      await f.runtime.runPromise(
        f.sessions.readTranscriptPage({
          sessionID: other.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      )
    ).history,
  ).toEqual([]);
  stop();
  const reopened = createSessionStore(
    f.remote,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  disposals.push(reopened.dispose);
  const restored = reopened.getSession(first.id);
  disposals.push(restored.subscribe(() => {}));
  await expect.poll(() => restored.getSnapshot().loading).toBe(false);
  while (restored.getSnapshot().history.hasMore) await restored.loadOlder();
  expect(
    restored
      .getSnapshot()
      .messages.filter((message) => message.role === "user")
      .map((message) => message.id),
  ).toEqual(["msg_model_0", "msg_model_1"]);
  expect(restored.getSnapshot().state?.messageInfo.msg_model_1?.model).toEqual(
    models[1],
  );
});

test("shares one socket with generic consumers and isolates same-session snapshots", async () => {
  const f = await fixture();
  const first = await f.remote.createSession({ title: "First" });
  const other = await f.remote.createSession({ title: "Other" });
  const a = f.observe(first.id);
  const b = f.observe(other.id);
  await expect.poll(() => a.received.length).toBe(2);
  await expect.poll(() => b.received.length).toBe(2);
  const late = f.observe(first.id);
  await expect.poll(() => late.received.length).toBe(2);
  expect(a.received.length).toBe(2);
  expect(b.received.length).toBe(2);
  expect(f.connections.opened).toBe(1);

  const sent = await f.runtime.runPromise(
    f.events.publish(ResourceChanged, {
      resource: "dashboard",
      id: "test-dashboard",
      revision: 1,
    }),
  );
  await expect
    .poll(() => f.frames)
    .toContainEqual({ kind: "event", event: sent });
  expect(a.received.length).toBe(2);
  a.close();
  b.close();
  late.close();
  expect(f.connections.active.size).toBe(1);
  f.stream.unsubscribe();
  await expect.poll(() => f.connections.active.size).toBe(0);
  const reopened = f.observe(first.id);
  await expect.poll(() => reopened.received.length).toBe(2);
  expect(f.connections.opened).toBe(2);
});

test("one snapshot initializes all waiting observers of its Session only", async () => {
  const held: Array<() => void> = [];
  const f = await fixture((request, _response, next) => {
    if (request.url?.startsWith("/trpc/agent.requestSnapshot")) held.push(next);
    else next();
  });
  const first = await f.remote.createSession({ title: "Shared" });
  const other = await f.remote.createSession({ title: "Independent" });
  const a = f.observe(first.id);
  await expect.poll(() => held.length).toBe(1);
  const b = f.observe(first.id);
  await expect.poll(() => held.length).toBe(2);
  const c = f.observe(other.id);
  await expect.poll(() => held.length).toBe(3);

  held[0]!();
  await expect.poll(() => a.received.length).toBe(2);
  await expect.poll(() => b.received.length).toBe(2);
  expect(c.received).toEqual([]);
  expect(f.snapshots[0]).toEqual({ sessionID: first.id, events: a.received });

  await f.runtime.runPromise(f.sessions.update(first.id, { title: "Live" }));
  await expect.poll(() => a.received.length).toBe(3);
  await expect.poll(() => b.received).toEqual(a.received);
  held[1]!();
  await expect.poll(() => f.snapshots.length).toBe(2);
  expect(a.received).toHaveLength(3);
  expect(b.received).toHaveLength(3);
  expect(c.received).toEqual([]);

  held[2]!();
  await expect.poll(() => c.received.length).toBe(2);
  expect(c.received[1]).toMatchObject({
    snapshot: { session: { id: other.id, title: "Independent" } },
  });
  expect(f.connections.opened).toBe(1);
});

test("includes pre-snapshot writes once and delivers later writes as live events", async () => {
  const held: Array<() => void> = [];
  const f = await fixture((request, _response, next) => {
    if (request.url?.startsWith("/trpc/agent.requestSnapshot")) held.push(next);
    else next();
  });
  const session = await f.remote.createSession({ title: "Original" });
  const observer = f.observe(session.id);
  await expect.poll(() => held.length).toBe(1);
  await f.runtime.runPromise(
    f.sessions.update(session.id, { title: "Before snapshot" }),
  );
  await expect
    .poll(() => f.frames)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event: expect.objectContaining({ type: "agent.event" }),
        }),
      ]),
    );
  expect(observer.received).toEqual([]);
  held[0]!();
  await expect
    .poll(() => observer.received)
    .toEqual([
      { type: EventType.MESSAGES_SNAPSHOT, messages: [] },
      expect.objectContaining({
        type: EventType.STATE_SNAPSHOT,
        snapshot: expect.objectContaining({
          session: expect.objectContaining({ title: "Before snapshot" }),
        }),
      }),
    ]);
  await f.runtime.runPromise(
    f.sessions.update(session.id, { title: "After snapshot" }),
  );
  await expect.poll(() => observer.received.length).toBe(3);
  expect(observer.received[2]).toMatchObject({
    type: EventType.STATE_DELTA,
    delta: [
      {
        op: "add",
        path: "/session",
        value: expect.objectContaining({ title: "After snapshot" }),
      },
    ],
  });
  expect(observer.errors).toEqual([]);
});

test("reconnect accepts a delayed snapshot and ignores the later duplicate", async () => {
  const held: Array<() => void> = [];
  const f = await fixture((request, _response, next) => {
    if (request.url?.startsWith("/trpc/agent.requestSnapshot")) held.push(next);
    else next();
  });
  const session = await f.remote.createSession({ title: "Original" });
  const observer = f.observe(session.id);
  await expect.poll(() => held.length).toBe(1);
  for (const response of f.connections.active) response.destroy();
  await expect.poll(() => f.connections.active.size).toBe(0);
  await f.runtime.runPromise(
    f.sessions.update(session.id, { title: "While disconnected" }),
  );
  await expect.poll(() => held.length, { timeout: 7_000 }).toBe(2);
  held[0]!();
  await expect.poll(() => observer.received.length).toBe(2);
  expect(observer.received[1]).toMatchObject({
    type: EventType.STATE_SNAPSHOT,
    snapshot: {
      session: { title: "While disconnected" },
    },
  });
  await f.runtime.runPromise(
    f.sessions.update(session.id, { title: "Live again" }),
  );
  await expect.poll(() => observer.received.length).toBe(3);
  held[1]!();
  await expect.poll(() => f.snapshots.length).toBe(2);
  expect(observer.received).toHaveLength(3);
  expect(observer.errors).toEqual([]);
  expect(f.connections.opened).toBe(2);
}, 10_000);

test.each(["disconnect", "detach", "snapshot"] as const)(
  "ignores a pending HTTP failure after %s",
  async (lifecycle) => {
    const held: Array<{ response: ServerResponse; next: () => void }> = [];
    const f = await fixture((request, response, next) => {
      if (request.url?.startsWith("/trpc/agent.requestSnapshot"))
        held.push({ response, next });
      else next();
    });
    const session = await f.remote.createSession({ title: "Waiting" });
    const original = f.observe(session.id);
    await expect.poll(() => held.length).toBe(1);

    let current = original;
    if (lifecycle === "disconnect") {
      for (const response of f.connections.active) response.destroy();
      await expect.poll(() => f.connections.active.size).toBe(0);
    } else {
      if (lifecycle === "detach") original.close();
      current = f.observe(session.id);
    }
    await expect.poll(() => held.length, { timeout: 7_000 }).toBe(2);
    if (lifecycle === "snapshot") {
      held[1]!.next();
      await expect.poll(() => original.received.length).toBe(2);
      await expect.poll(() => current.received.length).toBe(2);
    }

    held[0]!.response.writeHead(503).end("Snapshot unavailable");
    await f.remote.listSessions();
    if (lifecycle !== "snapshot") held[1]!.next();
    await expect.poll(() => current.received.length).toBe(2);
    await f.runtime.runPromise(
      f.sessions.update(session.id, { title: "Live" }),
    );
    await expect.poll(() => current.received.length).toBe(3);
    expect(original.errors).toEqual([]);
    expect(current.errors).toEqual([]);
  },
  10_000,
);

test("a failed snapshot terminates only its observer", async () => {
  const f = await fixture();
  const session = await f.remote.createSession({ title: "Healthy" });
  const healthy = f.observe(session.id);
  await expect.poll(() => healthy.received.length).toBe(2);
  const missing = f.observe("ses_missing");
  await expect.poll(() => missing.errors.length).toBe(1);
  expect(missing.received).toEqual([]);
  await f.runtime.runPromise(
    f.sessions.update(session.id, { title: "Still live" }),
  );
  await expect.poll(() => healthy.received.length).toBe(3);
  expect(healthy.errors).toEqual([]);
  expect(f.connections.opened).toBe(1);
});

function directory(
  remote: ReturnType<typeof createAgentClient>,
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
    },
  }),
) {
  const errors: unknown[] = [];
  const bridge = subscribeQueryInvalidation(remote, client, (error) =>
    errors.push(error),
  );
  const observer = new InfiniteQueryObserver(
    client,
    sessionsQueryOptions(remote),
  );
  const stop = observer.subscribe(() => {});
  disposals.push(() => {
    stop();
    bridge.unsubscribe();
    client.clear();
  });
  return {
    client,
    observer,
    errors,
    items: () => observer.getCurrentResult().data,
  };
}

test("lists chats, including bound ones, over HTTP and SSE, excluding other roots and children", async () => {
  const f = await fixture();
  const roots = [];
  for (let index = 0; index < 17; index++) {
    roots.push(
      index === 8
        ? await f.remote.getOrCreateBoundSession({
            key: "test:selection",
            kind: "chat",
            title: "Explain the selection",
          })
        : await f.remote.createSession({ title: `Chat ${index}` }),
    );
  }
  const oldest = roots[0]!;
  await f.runtime.runPromise(
    f.sessions.update(oldest.id, { title: "Recently active" }),
  );
  const child = await f.runtime.runPromise(
    f.sessions.create({ parentId: oldest.id, kind: "delegate" }),
  );
  for (const kind of ["scheduled", "delegate", "dig_in"] as const) {
    await f.runtime.runPromise(f.sessions.create({ kind }));
  }
  const archived = await f.remote.createSession({ title: "Archived" });
  await f.remote.archiveSession({ sessionID: archived.id });
  const first = await f.remote.listSessions();
  expect(first.items).toHaveLength(15);
  expect(first.items[0]?.id).toBe(oldest.id);
  expect(first.nextCursor).not.toBeNull();
  await f.remote.transport.rpc.agent.bootstrapSessions.mutate();
  await expect
    .poll(() => f.frames)
    .toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          type: "agent.sessions.bootstrap",
          data: {
            items: first.items.map((item) => expect.objectContaining(item)),
            nextCursor: first.nextCursor,
          },
        }),
      }),
    );
  const second = await f.remote.listSessions({ cursor: first.nextCursor! });
  expect(second.items).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  const ids = [...first.items, ...second.items].map((item) => item.id);
  expect(new Set(ids)).toEqual(new Set(roots.map((item) => item.id)));
  expect(ids).not.toContain(child.id);
  const created = await f.remote.listSessions({ orderBy: "createdAt" });
  expect(created.items).toHaveLength(15);
  const creationOrder = [...roots].sort(
    (a, b) =>
      b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  expect(created.items.map((item) => item.id)).toEqual(
    creationOrder.slice(0, 15).map((item) => item.id),
  );
  expect(created.items.map((item) => item.id)).not.toEqual(
    first.items.map((item) => item.id),
  );
  const createdNext = await f.remote.listSessions({
    orderBy: "createdAt",
    cursor: created.nextCursor!,
  });
  expect(
    [...created.items, ...createdNext.items].map((item) => item.id),
  ).toEqual(creationOrder.map((item) => item.id));
  await expect(
    f.remote.listSessions({
      orderBy: "updatedAt",
      cursor: created.nextCursor!,
    }),
  ).rejects.toThrow();
  expect(f.snapshots).toEqual([]);
});

test("archiving a bound chat hides directory entries over HTTP and SSE while preserving history, bindings and queued work", async () => {
  const f = await fixture();
  const key = "test:archived-chat";
  const session = await f.remote.getOrCreateBoundSession({
    key,
    kind: "chat",
    title: "Keep this history",
  });
  await addTurn(f, session.id, 1);
  const child = await f.runtime.runPromise(
    f.sessions.create({ parentId: session.id, kind: "delegate" }),
  );
  const runs = await f.runtime.runPromise(AgentRunStore.Service);
  const queued = await f.runtime.runPromise(
    runs.enqueue({
      sessionID: session.id,
      sessionIntentID: "archive-test",
      input: {
        agent: "analyst",
        model: { providerID: CODEX, modelID: "tier1" },
        parts: [{ type: "text", text: "Keep queued" }],
      },
    }),
  );
  const history = await f.remote.readTranscriptPage({ sessionID: session.id });
  const listing = directory(f.remote);
  await expect
    .poll(() => listing.items()?.map((item) => item.id))
    .toEqual([session.id]);

  const archived = await f.remote.archiveSession({ sessionID: session.id });
  expect(archived.archivedAt).toBeGreaterThan(0);
  await expect.poll(listing.items).toEqual([]);
  expect(await f.remote.listSessions()).toEqual({
    items: [],
    nextCursor: null,
  });
  await f.remote.transport.rpc.agent.bootstrapSessions.mutate();
  await expect
    .poll(() => f.frames)
    .toContainEqual(
      expect.objectContaining({
        kind: "event",
        event: expect.objectContaining({
          type: "agent.sessions.bootstrap",
          data: { items: [], nextCursor: null },
        }),
      }),
    );
  expect(await f.remote.readTranscriptPage({ sessionID: session.id })).toEqual(
    history,
  );
  expect(await f.runtime.runPromise(f.sessions.get(session.id))).toEqual(
    archived,
  );
  expect(await f.runtime.runPromise(f.sessions.get(child.id))).toEqual(child);
  expect(
    await f.remote.transport.rpc.agent.getSessionByBinding.query({ key }),
  ).toEqual(archived);
  expect(await f.runtime.runPromise(runs.list(session.id))).toEqual([queued]);
  await f.remote.archiveSession({ sessionID: session.id });
  expect((await f.remote.listSessions()).items).toEqual([]);
  await expect(
    f.remote.archiveSession({ sessionID: "ses_missing" }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND" },
  });
  expect(listing.errors).toEqual([]);
});

test("discovers a chat created in the background over the shared socket without opening its transcript", async () => {
  const f = await fixture();
  const listing = directory(f.remote);
  await expect.poll(listing.items).toEqual([]);
  const created = await f.runtime.runPromise(
    f.sessions.create({
      title: "Explain the selection",
      kind: "chat",
    }),
  );
  await expect.poll(listing.items).toEqual([
    {
      id: created.id,
      parentId: null,
      title: created.title,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
      isActive: false,
      isUnread: false,
    },
  ]);
  await f.runtime.runPromise(
    f.sessions.update(created.id, { title: "Updated" }),
  );
  await expect.poll(() => listing.items()?.[0]?.title).toBe("Updated");
  expect(listing.items()).toHaveLength(1);
  expect(f.snapshots).toEqual([]);
  const store = createSessionStore(
    f.remote,
    new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  disposals.push(() => store.dispose());
  const handle = store.getSession(created.id);
  expect(handle.getSnapshot().state).toBeUndefined();
  handle.subscribe(() => {});
  await expect.poll(() => handle.getSnapshot().loading).toBe(false);
  expect(handle.getSnapshot().state?.session.title).toBe("Updated");
  expect(f.snapshots).toHaveLength(1);
  expect(f.connections.opened).toBe(1);
  expect(listing.errors).toEqual([]);
});

test("shares a Query directory and excludes child Sessions while preserving default titles", async () => {
  const f = await fixture();
  const root = await f.remote.createSession({});
  expect(root.title).toBe("New session");
  const listing = directory(f.remote);
  await expect.poll(listing.items).toEqual([
    {
      id: root.id,
      parentId: null,
      title: root.title,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
      isActive: false,
      isUnread: false,
    },
  ]);
  await f.runtime.runPromise(
    f.sessions.create({
      parentId: root.id,
      kind: "delegate",
      title: "Research",
    }),
  );
  const late = new InfiniteQueryObserver(
    listing.client,
    sessionsQueryOptions(f.remote),
  );
  disposals.push(late.subscribe(() => {}));
  await expect
    .poll(() => late.getCurrentResult().data)
    .toEqual(listing.items());
  expect(listing.items()).toHaveLength(1);
  expect(f.snapshots).toEqual([]);
  expect(f.connections.opened).toBe(1);
});

test("refreshes the Query directory after disconnect before applying later live metadata changes", async () => {
  let hold = false;
  const held: Array<() => void> = [];
  const f = await fixture((request, _response, next) => {
    if (hold && request.url?.startsWith("/trpc/agent.listSessions"))
      held.push(next);
    else next();
  });
  const first = await f.remote.createSession({ title: "Before gap" });
  const listing = directory(f.remote);
  await expect
    .poll(() => listing.items()?.map((item) => item.id))
    .toEqual([first.id]);
  hold = true;
  for (const response of f.connections.active) response.destroy();
  await expect.poll(() => f.connections.active.size).toBe(0);
  const missed = await f.runtime.runPromise(
    f.sessions.create({ title: "While disconnected" }),
  );
  await expect.poll(() => held.length, { timeout: 7_000 }).toBeGreaterThan(0);
  expect(listing.items()?.map((item) => item.id)).toEqual([first.id]);
  hold = false;
  for (const release of held.splice(0)) release();
  await expect
    .poll(() => listing.items()?.map((item) => item.id))
    .toEqual([missed.id, first.id]);
  await f.runtime.runPromise(
    f.sessions.update(missed.id, { title: "Live again" }),
  );
  await expect.poll(() => listing.items()?.[0]?.title).toBe("Live again");
  expect(f.snapshots).toEqual([]);
  expect(f.connections.opened).toBe(2);
  expect(listing.errors).toEqual([]);
}, 10_000);
