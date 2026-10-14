// Purpose: Locks delivery scope, detached event payloads, and canonical delegate bootstraps.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { EventType } from "@ag-ui/core";
import type { Assistant } from "@openchart/server/agent/contracts/message";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import { ID as PermissionID } from "@openchart/server/agent/permission/types";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { ID as RunID, type AgentRun } from "@openchart/server/agent/run/run";
import { Session } from "@openchart/server/agent/session";
import { DEFAULT_HISTORY_TURN_LIMIT } from "@openchart/server/agent/session/operations/read-transcript-page";
import { makeRuntime } from "@openchart/server/runtime";
import { EventDefinition, Events } from "@openchart/server/events";
import { Effect, Schema, Stream } from "effect";
import { afterEach, expect, test } from "vitest";
import { publishSnapshot } from "./adapter";
import { readHistoryPage } from "./history";
import { AgentSnapshot, AgentEvent } from "./events";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const collected = EventDefinition.define({
  type: "test.collected",
  schema: {},
});

function collect<A, E, R>(program: Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const events = yield* Events.Service;
      const stream = yield* events.allBounded(256);
      yield* program;
      yield* events.publish(collected, {});
      return yield* Stream.runCollect(
        stream.pipe(Stream.takeUntil((event) => event.type === collected.type)),
      );
    }),
  );
}

function native(events: readonly EventDefinition.Payload[]) {
  return events
    .filter((event) => event.type === AgentEvent.type)
    .map((event) => Schema.decodeUnknownSync(AgentEvent)(event).data);
}

async function fixture() {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  disposals.push(() => runtime.dispose());
  const tree = await runtime.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const conversation = Effect.fn(function* (
        name: string,
        parent?: Assistant,
      ) {
        const session = yield* sessions.create({
          title: name,
          ...(parent ? { parentId: parent.sessionID, kind: "delegate" } : {}),
        });
        const user = yield* sessions.createMessage({
          info: {
            id: `msg_${name}_user`,
            sessionID: session.id,
            role: "user",
            agent: "analyst",
            workspaceId: `wsp_${name}`,
            model: { providerID: "codex" as const, modelID: "tier1" as const },
            time: { created: 1 },
          },
          parts: [
            {
              id: `prt_${name}_input`,
              messageID: `msg_${name}_user`,
              type: "text",
              text: `${name} input`,
            },
          ],
        });
        const assistant: Assistant = {
          id: `msg_${name}_assistant`,
          sessionID: session.id,
          role: "assistant",
          triggeringUserMessageID: user.info.id,
          agent: "analyst",
          providerID: "test",
          modelID: "test",
          path: { cwd: "/test", root: "/test" },
          time: { created: 2 },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        };
        yield* sessions.createMessage({ info: assistant, parts: [] });
        if (parent)
          yield* sessions.createPart({
            id: `prt_${name}_proxy`,
            messageID: parent.id,
            type: "tool",
            tool: "Agent",
            callID: `call_${name}`,
            childSessionIds: [session.id],
            state: { status: "running", input: {}, time: { start: 2 } },
          });
        return { session: (yield* sessions.get(session.id))!, assistant };
      });
      const root = yield* conversation("root");
      const child = yield* conversation("child", root.assistant);
      const nested = yield* conversation("nested", child.assistant);
      return { root, child, nested, sessions };
    }),
  );
  return { runtime, ...tree };
}

test("history pages include only the selected turns' delegates at their latest turn and keep child input private", async () => {
  const f = await fixture();
  const { first, older, events } = await f.runtime.runPromise(
    Effect.gen(function* () {
      for (const { assistant } of [f.child, f.nested])
        yield* f.sessions.createPart({
          id: `prt_${assistant.id}_answer`,
          messageID: assistant.id,
          type: "text",
          text: `${assistant.id} output`,
        });
      // A delegate normally has one turn. This child gets a whole page of later
      // turns, so its latest page excludes the first turn and the nested
      // delegate linked from there.
      for (let turn = 0; turn < DEFAULT_HISTORY_TURN_LIMIT; turn++) {
        const user = `msg_child_z${turn}_user`;
        yield* f.sessions.createMessage({
          info: {
            id: user,
            sessionID: f.child.session.id,
            role: "user",
            agent: "analyst",
            model: { providerID: "codex", modelID: "tier1" },
            time: { created: 3 + turn },
          },
          parts: [],
        });
        yield* f.sessions.createMessage({
          info: {
            ...f.child.assistant,
            id: `msg_child_zz${turn}_reply`,
            triggeringUserMessageID: user,
            time: { created: 3 + turn },
          },
          parts: [
            {
              id: `prt_child_later_${turn}`,
              messageID: `msg_child_zz${turn}_reply`,
              type: "text",
              text: `Child turn ${turn + 2}`,
            },
          ],
        });
      }
      yield* f.sessions.createMessage({
        info: {
          id: "msg_tail",
          sessionID: f.root.session.id,
          role: "user",
          agent: "analyst",
          model: { providerID: "codex", modelID: "tier1" },
          time: { created: 3 },
        },
        parts: [
          {
            id: "prt_tail",
            messageID: "msg_tail",
            type: "text",
            text: "Next turn",
          },
        ],
      });
      const bus = yield* Events.Service;
      const first = yield* bus.withBarrier(
        readHistoryPage({ sessionID: f.root.session.id, turnLimit: 1 }),
      );
      const older = yield* bus.withBarrier(
        readHistoryPage({
          sessionID: f.root.session.id,
          cursor: first.nextCursor!,
          turnLimit: 1,
        }),
      );
      const events = yield* collect(
        bus.withBarrier(
          readHistoryPage({
            sessionID: f.root.session.id,
            cursor: first.nextCursor!,
            turnLimit: 1,
          }),
        ),
      );
      return { first, older, events };
    }),
  );
  expect(first.messages.map((message) => message.id)).toEqual(["msg_tail"]);
  expect(first.lifecycle).toEqual([]);
  expect(older.nextCursor).toBeNull();
  expect(
    older.messages
      .filter((message) => message.role === "user")
      .map((message) => message.id),
  ).toEqual(["msg_root_user"]);
  expect(older.messages).toContainEqual(
    expect.objectContaining({
      id: `prt_child_later_${DEFAULT_HISTORY_TURN_LIMIT - 1}`,
      content: `Child turn ${DEFAULT_HISTORY_TURN_LIMIT + 1}`,
      subagentRunId: "prt_child_proxy",
    }),
  );
  expect(older.messages.map((message) => message.id)).not.toContain(
    "prt_msg_child_assistant_answer",
  );
  expect(older.messages.map((message) => message.id)).not.toContain(
    "prt_msg_nested_assistant_answer",
  );
  expect(older.lifecycle).toEqual([
    expect.objectContaining({
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: "prt_child_proxy",
    }),
  ]);
  expect(older.messageInfo).not.toHaveProperty("msg_child_user");
  expect(older.messageInfo).not.toHaveProperty("msg_nested_user");
  expect(native(events)).toEqual([]);
});

test.each([1, 2])(
  "workflow with %i children keeps trace presentation during live updates",
  async (count) => {
    const f = await fixture();
    const trace = { resourceSpans: [] };
    const result = await f.runtime.runPromise(
      collect(
        Effect.gen(function* () {
          const children = [];
          for (let i = 0; i < count; i++) {
            const child = yield* f.sessions.create({
              title: `Workflow child ${i}`,
              parentId: f.root.session.id,
              kind: "delegate",
            });
            const assistant = {
              ...f.child.assistant,
              id: `msg_workflow_${i}`,
              sessionID: child.id,
            };
            yield* f.sessions.createMessage({ info: assistant, parts: [] });
            children.push(assistant);
          }
          const tool: ToolPart = {
            id: "prt_workflow",
            messageID: f.root.assistant.id,
            type: "tool",
            tool: "workflow",
            callID: "call_workflow",
            childSessionIds: [],
            state: {
              status: "running",
              input: {},
              time: { start: 1 },
              metadata: { trace },
            },
          };
          yield* f.sessions.createPart(tool);
          yield* f.sessions.updatePart({
            ...tool,
            childSessionIds: children.map((child) => child.sessionID),
          });
          for (const child of children)
            yield* f.sessions.createPart({
              id: `prt_${child.id}`,
              messageID: child.id,
              type: "text",
              text: "Workflow child output",
            });
          yield* f.sessions.updatePart({
            ...tool,
            childSessionIds: children.map((child) => child.sessionID),
            state: {
              status: "completed",
              input: {},
              title: "Done",
              output: { type: "text", value: "Workflow result" },
              time: { start: 1, end: 2 },
              metadata: { trace },
            },
          });
        }),
      ),
    );
    const root = native(result)
      .filter(({ sessionID }) => sessionID === f.root.session.id)
      .map(({ event }) => event);
    expect(root.some((event) => event.type.startsWith("SUBAGENT_"))).toBe(
      false,
    );
    expect(JSON.stringify(root)).not.toContain("Workflow child output");
    expect(
      root.find((event) => event.type === EventType.ACTIVITY_SNAPSHOT),
    ).toMatchObject({ content: { details: { trace } } });
    expect(JSON.stringify(root)).not.toContain("childSessionId");
    expect(
      root.some((event) => event.type === EventType.TOOL_CALL_RESULT),
    ).toBe(true);
  },
);

test("routes metadata, supplied permission views and Run lifecycle to their specified Session, with detached payloads", async () => {
  const f = await fixture();
  const run: AgentRun = {
    id: RunID.create(),
    sessionID: f.nested.session.id,
    sessionIntentID: "intent",
    input: {
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
      parts: [{ type: "text", text: "Private run input" }],
    },
    status: "running",
    queuePosition: 0,
    createdAt: 1,
    startedAt: 2,
    finishedAt: null,
  };
  const permissions = [
    {
      id: PermissionID.make("per_test"),
      sessionID: f.nested.session.id,
      action: "read",
      resources: ["private"],
    },
  ];
  const result = await f.runtime.runPromise(
    collect(
      Effect.gen(function* () {
        const publisher = yield* Publisher.Service;
        const events = yield* Events.Service;
        yield* f.sessions.update(f.nested.session.id, { title: "Renamed" });
        yield* events.withBarrier(
          Effect.gen(function* () {
            yield* publisher.publish({
              type: "permissions.updated",
              sessionID: run.sessionID,
              permissions,
            });
            yield* publisher.publish({
              type: "run.updated",
              operation: "claim",
              run,
              runs: [run],
            });
            yield* publisher.publish({
              type: "run.updated",
              operation: "complete",
              run: { ...run, status: "completed", finishedAt: 3 },
              runs: [{ ...run, status: "completed", finishedAt: 3 }],
            });
          }),
        );
        permissions[0]!.resources.push("later mutation");
        run.status = "failed";
      }),
    ),
  );
  const delivered = native(result);
  expect(
    delivered.every((event) => event.sessionID === f.nested.session.id),
  ).toBe(true);
  expect(delivered.map(({ event }) => event.type)).toEqual([
    EventType.STATE_DELTA,
    EventType.STATE_DELTA,
    EventType.RUN_STARTED,
    EventType.STATE_DELTA,
    EventType.STATE_DELTA,
    EventType.RUN_FINISHED,
  ]);
  expect(delivered.map(({ event }) => event.subagentRunId)).toEqual(
    Array(6).fill(undefined),
  );
  expect(delivered[1]!.event).toMatchObject({
    delta: [{ path: "/permissions", value: [{ resources: ["private"] }] }],
  });
  expect(delivered[3]!.event).toMatchObject({
    delta: [{ path: "/runs", value: [{ status: "running" }] }],
  });
  expect(JSON.stringify(delivered)).not.toContain("Private run input");
});

test("attributes ordered child output to every ancestor and closes an interrupted invocation only once", async () => {
  const f = await fixture();
  const result = await f.runtime.runPromise(
    collect(
      Effect.gen(function* () {
        const part = yield* f.sessions.createPart({
          id: "prt_reasoning",
          messageID: f.nested.assistant.id,
          type: "reasoning",
          text: "Thinking",
          time: { start: 3 },
        });
        yield* f.sessions.updatePart({ ...part, time: { start: 3, end: 4 } });
        const completed: Assistant = {
          ...f.nested.assistant,
          time: { created: 2, completed: 5 },
          error: {
            name: "MessageAbortedError",
            data: { message: "Cancelled" },
          },
        };
        yield* f.sessions.updateMessage(completed);
        yield* f.sessions.updateMessage({ ...completed, cost: 1 });
        const proxy: ToolPart = {
          id: "prt_nested_proxy",
          messageID: f.child.assistant.id,
          type: "tool",
          tool: "Agent",
          callID: "call_nested",
          childSessionIds: [f.nested.session.id],
          state: {
            status: "error",
            input: {},
            error: "Cancelled",
            time: { start: 2, end: 5 },
          },
        };
        yield* f.sessions.updatePart(proxy);
        yield* f.sessions.updatePart(proxy);
      }),
    ),
  );
  const delivered = native(result);
  for (const { session } of [f.root, f.child]) {
    const events = delivered
      .filter((event) => event.sessionID === session.id)
      .map(({ event }) => event);
    expect(events.slice(0, 7).map((event) => event.type)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.STATE_DELTA,
      EventType.STATE_DELTA,
    ]);
    expect(
      events
        .slice(0, 7)
        .every((event) => event.subagentRunId === "prt_nested_proxy"),
    ).toBe(true);
    expect(
      events.filter((event) => event.type === EventType.SUBAGENT_ERROR),
    ).toEqual([
      {
        type: EventType.SUBAGENT_ERROR,
        subagentRunId: "prt_nested_proxy",
        message: "Cancelled",
      },
    ]);
  }
  const local = delivered.filter(
    (event) => event.sessionID === f.nested.session.id,
  );
  expect(local).toHaveLength(7);
  expect(local.every(({ event }) => event.subagentRunId === undefined)).toBe(
    true,
  );
  const parent = delivered.find(
    (event) => event.sessionID === f.child.session.id,
  )!;
  const root = delivered.find(
    (event) => event.sessionID === f.root.session.id,
  )!;
  parent.event.metadata = { mutated: true };
  expect(root.event.metadata).not.toEqual({ mutated: true });
  expect(local[0]!.event.metadata).not.toEqual({ mutated: true });
});

test("publishes a snapshot of the requested tree with local state, private inputs and lifecycle before open streams", async () => {
  const f = await fixture();
  await f.runtime.runPromise(
    f.sessions.createPart({
      id: "prt_text",
      messageID: f.nested.assistant.id,
      type: "text",
      text: "Partial answer",
      time: { start: 3 },
    }),
  );
  const result = await f.runtime.runPromise(
    collect(
      Effect.gen(function* () {
        yield* publishSnapshot(f.root.session.id);
        yield* publishSnapshot(f.child.session.id);
      }),
    ),
  );
  expect(native(result)).toEqual([]);
  const snapshots = result
    .filter((event) => event.type === AgentSnapshot.type)
    .map((event) => Schema.decodeUnknownSync(AgentSnapshot)(event).data);
  expect(snapshots).toHaveLength(2);
  for (const [index, conversation] of [f.root, f.child].entries()) {
    const { events, sessionID } = snapshots[index]!;
    expect(sessionID).toBe(conversation.session.id);
    expect(events[0]).toMatchObject({ type: EventType.MESSAGES_SNAPSHOT });
    if (events[0]?.type !== EventType.MESSAGES_SNAPSHOT)
      throw new Error("Expected messages");
    expect(
      events[0].messages
        .filter((message) => message.role === "user")
        .map((message) => message.id),
    ).toEqual([`msg_${conversation.session.title}_user`]);
    expect(
      events[0].messages.find((message) => message.id === "prt_text"),
    ).toMatchObject({
      subagentRunId: "prt_nested_proxy",
      content: "Partial answer",
    });
    expect(events[1]).toMatchObject({
      type: EventType.STATE_SNAPSHOT,
      snapshot: {
        session: conversation.session,
        runs: [],
        questions: [],
        permissions: [],
        messageInfo: {
          [`msg_${conversation.session.title}_user`]: {
            workspaceId: `wsp_${conversation.session.title}`,
          },
          msg_nested_assistant: { completedAt: null, error: null },
        },
      },
    });
    const starts = events.filter(
      (event) => event.type === EventType.SUBAGENT_STARTED,
    );
    expect(starts).toHaveLength(index === 0 ? 2 : 1);
    expect(starts[0]).not.toHaveProperty("parentSubagentRunId");
    expect(events.slice(2, 2 + starts.length)).toEqual(starts);
    expect(events.at(-1)).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "prt_text",
      subagentRunId: "prt_nested_proxy",
    });
  }
});

test("rebuilds ancestor snapshots after a child input replacement without sharing that input or state scope", async () => {
  const f = await fixture();
  const result = await f.runtime.runPromise(
    collect(
      f.sessions.updatePart({
        id: "prt_nested_input",
        messageID: "msg_nested_user",
        type: "text",
        text: "Changed private input",
      }),
    ),
  );
  const delivered = native(result);
  expect(delivered.map((event) => event.sessionID)).toEqual([
    f.nested.session.id,
    f.nested.session.id,
    f.child.session.id,
    f.child.session.id,
    f.root.session.id,
    f.root.session.id,
  ]);
  for (const { event } of delivered) {
    expect(event).not.toHaveProperty("subagentRunId");
    if (event.type === EventType.STATE_DELTA)
      expect(event.delta).toEqual([
        { op: "add", path: "/messageInfo", value: expect.any(Object) },
        { op: "add", path: "/history", value: { nextCursor: null } },
      ]);
  }
  expect(JSON.stringify(delivered.slice(0, 2))).toContain(
    "Changed private input",
  );
  expect(JSON.stringify(delivered.slice(2))).not.toContain(
    "Changed private input",
  );
  expect(delivered.at(-1)!.event).toMatchObject({
    delta: [
      {
        value: {
          msg_root_assistant: expect.any(Object),
          msg_child_assistant: expect.any(Object),
          msg_nested_assistant: expect.any(Object),
        },
      },
      { op: "add", path: "/history", value: { nextCursor: null } },
    ],
  });
});
