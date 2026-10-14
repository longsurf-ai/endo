// Purpose: Verifies execution requirements and transaction semantics through Session.Service.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import * as Agui from "@openchart/server/agent/publisher/agui/adapter";
import type * as Message from "@openchart/server/agent/contracts/message";
import type {
  StepFinishPart,
  TextPart,
} from "@openchart/server/agent/contracts/part";
import { EventType } from "@ag-ui/core";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import { Session } from "@openchart/server/agent/session";
import { SessionId } from "@openchart/server/agent/contracts/session";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { BranchUnavailable } from "@openchart/server/agent/session/errors";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Question } from "@openchart/server/agent/question";
import { Permission } from "@openchart/server/agent/permission";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { makeRuntime } from "@openchart/server/runtime";
import { Database } from "@openchart/server/db";
import { EventDefinition, Events } from "@openchart/server/events";
import { Context, Effect, Exit, Layer, Schema, Struct } from "effect";
import { expect, expectTypeOf, test, vi } from "vitest";

function run<A, E>(
  program: (
    published: EventDefinition.Payload[],
  ) => Effect.Effect<
    A,
    E,
    Session.Service | Database.Service | Events.Service | Publisher.Service
  >,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const dependencies = yield* Layer.build(
          Layer.mergeAll(
            Database.layer(":memory:", () => Effect.void),
            Events.layer,
          ),
        );
        const events = Context.get(dependencies, Events.Service);
        const published: EventDefinition.Payload[] = [];
        const checked: Events.Interface = {
          ...events,
          publish: (definition, data, options) =>
            events.publish(definition, data, options).pipe(
              Effect.tap((event) =>
                Effect.sync(() => {
                  published.push(event);
                }),
              ),
            ),
        };
        return yield* program(published).pipe(
          Effect.provide(Layer.fresh(Agui.layer)),
          Effect.provide(Session.layer),
          Effect.provide(Context.add(dependencies, Events.Service, checked)),
        );
      }),
    ),
  );
}

test("resolves Session and transcript dependencies from the execution context", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const session = yield* Session.Service;
      expectTypeOf<
        Effect.Services<ReturnType<typeof session.get>>
      >().toEqualTypeOf<Database.Service>();
      expectTypeOf<
        Effect.Services<ReturnType<typeof session.readTranscriptPage>>
      >().toEqualTypeOf<Database.Service>();
      expectTypeOf<
        Effect.Services<ReturnType<typeof session.readSnapshot>>
      >().toEqualTypeOf<
        | Database.Service
        | AgentRunStore.Service
        | Permission.Service
        | Question.Service
      >();
      expectTypeOf<
        Effect.Services<ReturnType<typeof session.create>>
      >().toEqualTypeOf<
        Database.Service | Events.Service | Publisher.Service
      >();
      const root = yield* session.create();
      expect(root).toMatchObject({
        title: "New session",
        parentId: null,
        kind: "chat",
      });
      expect(yield* session.get(root.id)).toEqual(root);

      const info: Message.User = {
        id: "user",
        sessionID: root.id,
        role: "user",
        time: { created: 10 },
        agent: "analyst",
        model: { providerID: "codex" as const, modelID: "tier1" as const },
      };
      const message = yield* session.createMessage({ info, parts: [] });
      expect(
        yield* session.getMessage({ sessionID: root.id, messageID: info.id }),
      ).toEqual(message);
      const part: TextPart = {
        id: "part",
        messageID: info.id,
        type: "text",
        text: "first",
      };
      const saved = yield* session.createPart(part);
      part.text = "mutated";
      expect(published.at(-2)?.data).toMatchObject({
        event: { messages: [{ content: "first" }] },
      });
      expect(
        yield* session.getPart({
          sessionID: root.id,
          messageID: info.id,
          partID: part.id,
        }),
      ).toEqual(saved);
      expect(
        yield* session.readTranscriptPage({
          sessionID: root.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual({
        session: yield* session.get(root.id),
        history: [{ info, parts: [saved] }],
        nextCursor: null,
      });
      expect(
        published.map(
          (event) =>
            Schema.decodeUnknownSync(AgentEvent)(event).data.event.type,
        ),
      ).toEqual([
        // create: session
        EventType.STATE_DELTA,
        // createMessage: user header, then the appended user message
        EventType.STATE_DELTA,
        EventType.TEXT_MESSAGE_START,
        EventType.TEXT_MESSAGE_END,
        EventType.STATE_DELTA,
        // createPart on a user message replaces history
        EventType.MESSAGES_SNAPSHOT,
        EventType.STATE_DELTA,
      ]);
    }),
  );
});

test("reads a Session snapshot without exposing or changing stored Run inputs", async () => {
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service;
        const runs = yield* AgentRunStore.Service;
        const events = yield* Events.Service;
        const root = yield* session.create();
        const other = yield* session.create();
        const input = {
          agent: "analyst",
          model: { providerID: "codex" as const, modelID: "tier1" as const },
          parts: [{ type: "text" as const, text: "Analyze this." }],
        };
        const admitted = yield* runs.enqueue({
          sessionID: root.id,
          sessionIntentID: "intent-root",
          input,
        });
        yield* runs.enqueue({
          sessionID: other.id,
          sessionIntentID: "intent-other",
          input,
        });
        const snapshot = yield* events.withBarrier(
          session.readSnapshot(root.id),
        );
        expect(snapshot).toMatchObject({
          history: [],
          state: {
            session: root,
            runs: [{ id: admitted.id, status: "queued" }],
            questions: [],
            permissions: [],
          },
        });
        expect(snapshot.state.runs).toHaveLength(1);
        expect(snapshot.state.runs[0]).not.toHaveProperty("input");
        expect(yield* runs.get(admitted.id)).toEqual(admitted);
        expect(
          yield* events.withBarrier(
            Effect.flip(session.readSnapshot("ses_missing")),
          ),
        ).toMatchObject({ entity: "session", id: "ses_missing" });
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

test("creates delegate Sessions through the derived service API", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const session = yield* Session.Service;
      const parent = yield* session.create();
      const child = yield* session.create({
        parentId: parent.id,
        kind: "delegate",
        title: "Delegate",
      });
      expect(child).toMatchObject({
        parentId: parent.id,
        kind: "delegate",
        title: "Delegate",
      });
      expect(yield* session.get(child.id)).toEqual(child);
      expect(
        published.map(
          (event) => Schema.decodeUnknownSync(AgentEvent)(event).data,
        ),
      ).toMatchObject([
        {
          sessionID: parent.id,
          event: {
            type: EventType.STATE_DELTA,
            delta: [{ op: "add", path: "/session", value: parent }],
          },
        },
        {
          sessionID: child.id,
          event: {
            type: EventType.STATE_DELTA,
            delta: [{ op: "add", path: "/session", value: child }],
          },
        },
      ]);
    }),
  );
});

test("preserves finishStep rollback and suppresses publication on failure", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const session = yield* Session.Service;
      const root = yield* session.create();
      const tokens = {
        input: 1,
        output: 2,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      };
      const info: Message.Assistant = {
        id: "assistant",
        sessionID: root.id,
        role: "assistant",
        time: { created: 20 },
        triggeringUserMessageID: "user",
        agent: "analyst",
        providerID: "openai",
        modelID: "test",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens,
      };
      const part: StepFinishPart = {
        id: "step",
        messageID: info.id,
        type: "step-finish",
        reason: "stop",
        cost: 1,
        tokens,
      };
      const original = yield* session.createMessage({ info, parts: [part] });
      published.length = 0;
      const exit = yield* Effect.exit(
        session.finishStep({
          message: { ...info, cost: 1, finish: "stop" },
          part,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(
        yield* session.getMessage({ sessionID: root.id, messageID: info.id }),
      ).toEqual(original);
      expect(published).toEqual([]);
    }),
  );
});

test("forks a paginated history through an Assistant with fresh IDs and independent continuation", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const source = yield* sessions.getOrCreateBound({
        kind: "chat",
        key: "fork-test",
        title: "Research",
      });
      // Cross the Store's 100-message page boundary with equal content timestamps.
      for (let i = 0; i < 101; i++) {
        const id = `msg_user_${String(i).padStart(3, "0")}`;
        yield* sessions.createMessage({
          info: {
            id,
            sessionID: source.id,
            role: "user",
            time: { created: 10 },
            agent: "analyst",
            model: { providerID: "codex" as const, modelID: "tier1" as const },
          },
          parts: [
            {
              id: `prt_user_${i}`,
              messageID: id,
              type: "text",
              text: `Question ${i}`,
            },
          ],
        });
      }
      const info: Message.Assistant = {
        id: "msg_user_101_reply",
        sessionID: source.id,
        role: "assistant",
        triggeringUserMessageID: "msg_user_100",
        time: { created: 11, completed: 12 },
        modelID: "test",
        providerID: "openai",
        agent: "analyst",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "stop",
      };
      yield* sessions.createMessage({
        info,
        parts: [
          {
            id: "prt_reply_1",
            messageID: info.id,
            type: "reasoning",
            text: "Think",
            time: { start: 11, end: 12 },
          },
          {
            id: "prt_reply_2",
            messageID: info.id,
            type: "tool",
            childSessionIds: [],
            tool: "echo",
            callID: "call_1",
            state: {
              status: "completed",
              input: { text: "ok" },
              output: { type: "text", value: "ok" },
              title: "Echo",
              metadata: {},
              time: { start: 11, end: 12 },
            },
          },
          {
            id: "prt_reply_3",
            messageID: info.id,
            type: "text",
            text: "Selected reply",
            time: { start: 11, end: 12 },
          },
        ],
      });
      yield* sessions.createMessage({
        info: { ...info, id: "msg_user_102_later", time: { created: 13 } },
        parts: [
          {
            id: "prt_later",
            messageID: "msg_user_102_later",
            type: "text",
            text: "Later streaming reply",
          },
        ],
      });
      const original = yield* sessions.readTranscriptPage({
        sessionID: source.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      published.length = 0;
      const fork = yield* sessions.fork({
        sessionID: source.id,
        messageID: info.id,
      });
      expect(fork).toMatchObject({
        title: "Branch of Research",
        parentId: null,
        kind: "chat",
        bindingId: null,
        anchors: null,
      });
      expect(published).toHaveLength(1);
      expect(published[0]?.data).toMatchObject({ sessionID: fork.id });
      const { history } = yield* sessions.readTranscriptPage({
        sessionID: fork.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(history).toHaveLength(102);
      const reply = history.at(-1)!;
      expect(reply.info).toMatchObject({
        role: "assistant",
        triggeringUserMessageID: history.at(-2)!.info.id,
      });
      expect(history.map(({ info }) => info.id)).toEqual(
        history.map(({ info }) => info.id).sort(),
      );
      for (const [index, message] of history.entries()) {
        expect(message.info.id).not.toBe(original.history[index]!.info.id);
        expect(message.info.sessionID).toBe(fork.id);
        expect(
          message.parts.map((part) => Struct.omit(part, ["id", "messageID"])),
        ).toEqual(
          original.history[index]!.parts.map((part) =>
            Struct.omit(part, ["id", "messageID"]),
          ),
        );
        for (const part of message.parts)
          expect(part.messageID).toBe(message.info.id);
      }
      // Copying again works, and changes to a branch cannot mutate the source.
      yield* sessions.fork({ sessionID: fork.id, messageID: reply.info.id });
      const copiedText = reply.parts.at(-1)!;
      if (copiedText.type !== "text") throw new Error("Expected reply text");
      yield* sessions.updatePart({ ...copiedText, text: "Changed branch" });
      expect(
        yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual(original);
      expect(
        (yield* sessions.getOrCreateBound({ kind: "chat", key: "fork-test" }))
          .id,
      ).toBe(source.id);
    }),
  );
});

test("rejects missing, foreign, user and unfinished fork targets without writes or publication", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const source = yield* sessions.create();
      const other = yield* sessions.create();
      const info: Message.User = {
        id: "msg_user",
        sessionID: source.id,
        role: "user",
        time: { created: 1 },
        agent: "analyst",
        model: { providerID: "codex" as const, modelID: "tier1" as const },
      };
      yield* sessions.createMessage({ info, parts: [] });
      const assistant: Message.Assistant = {
        id: "msg_reply",
        sessionID: source.id,
        role: "assistant",
        triggeringUserMessageID: info.id,
        time: { created: 2 },
        modelID: "test",
        providerID: "openai",
        agent: "analyst",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      };
      yield* sessions.createMessage({
        info: assistant,
        parts: [
          {
            id: "prt_reply",
            messageID: assistant.id,
            type: "text",
            text: "Streaming",
          },
        ],
      });
      published.length = 0;
      for (const input of [
        { sessionID: other.id, messageID: assistant.id },
        { sessionID: source.id, messageID: "missing" },
        { sessionID: source.id, messageID: info.id },
        { sessionID: source.id, messageID: assistant.id },
      ])
        expect(
          Exit.isFailure(yield* sessions.fork(input).pipe(Effect.exit)),
        ).toBe(true);
      expect((yield* sessions.list({ limit: 20 })).items).toHaveLength(2);
      expect(published).toEqual([]);
    }),
  );
});

const digInSource = Effect.fn("test.digInSource")(function* (
  sessions: Session.Interface,
) {
  const source = yield* sessions.create({ title: "Research" });
  yield* sessions.createMessage({
    info: {
      id: "msg_001_question",
      sessionID: source.id,
      role: "user",
      time: { created: 1 },
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
    },
    parts: [
      {
        id: "prt_question",
        messageID: "msg_001_question",
        type: "text",
        text: "Research context",
      },
    ],
  });
  yield* sessions.createMessage({
    info: {
      id: "msg_002_answer",
      sessionID: source.id,
      role: "assistant",
      triggeringUserMessageID: "msg_001_question",
      time: { created: 2, completed: 3 },
      modelID: "test",
      providerID: "openai",
      agent: "analyst",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    },
    parts: [
      {
        id: "prt_answer",
        messageID: "msg_002_answer",
        type: "text",
        text: "A **selected** reply",
      },
      {
        id: "prt_reasoning",
        messageID: "msg_002_answer",
        type: "reasoning",
        text: "Private",
        time: { start: 2, end: 3 },
      },
      {
        id: "prt_synthetic",
        messageID: "msg_002_answer",
        type: "text",
        text: "Hidden",
        synthetic: true,
      },
    ],
  });
  return {
    sessionID: source.id,
    messageID: "msg_002_answer",
    selection: {
      partId: "prt_answer",
      text: "selected",
      startOffset: 2,
      endOffset: 10,
    },
  };
});

test("creates independent anchored Dig Ins per call without exposing or changing source history", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const input = yield* digInSource(sessions);
      const before = yield* sessions.readTranscriptPage({
        sessionID: input.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      published.length = 0;
      const child = yield* sessions.digIn(input);
      expect(child).toMatchObject({
        parentId: input.sessionID,
        kind: "dig_in",
        bindingId: null,
        anchors: null,
      });
      expect(published).toHaveLength(2);
      expect(published.map((event) => event.data)).toMatchObject([
        { sessionID: child.id },
        { sessionID: input.sessionID },
      ]);
      const copied = {
        history: (yield* sessions.listMessages({
          sessionID: child.id,
          limit: Number.MAX_SAFE_INTEGER,
        })).items,
      };
      expect(copied.history).toHaveLength(2);
      expect(
        (yield* sessions.readTranscriptPage({ sessionID: child.id })).history,
      ).toEqual([]);
      expect(copied.history.map(({ info }) => info.id)).not.toEqual(
        before.history.map(({ info }) => info.id),
      );
      expect(copied.history[1]?.info).toMatchObject({
        triggeringUserMessageID: copied.history[0]!.info.id,
      });
      expect(
        copied.history[1]?.parts.map((part) =>
          Struct.omit(part, ["id", "messageID"]),
        ),
      ).toEqual(
        before.history[1]?.parts.map((part) =>
          Struct.omit(part, ["id", "messageID"]),
        ),
      );
      expect(
        (yield* sessions.readTranscriptPage({
          sessionID: input.sessionID,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history,
      ).toEqual(before.history);
      expect((yield* sessions.get(input.sessionID))?.anchors).toEqual([
        {
          ...input.selection,
          childSessionId: child.id,
        },
      ]);
      const additional = yield* Effect.all(
        [sessions.digIn(input), sessions.digIn(input)],
        { concurrency: "unbounded" },
      );
      const children = [child, ...additional];
      expect(new Set(children.map(({ id }) => id)).size).toBe(3);
      expect((yield* sessions.list({ limit: 20 })).items).toHaveLength(4);
      expect((yield* sessions.get(input.sessionID))?.anchors).toEqual(
        expect.arrayContaining(
          children.map(({ id }) => ({
            ...input.selection,
            childSessionId: id,
          })),
        ),
      );
      expect((yield* sessions.get(input.sessionID))?.anchors).toHaveLength(3);
    }),
  );
});

test("rejects invalid targets and recursive branches without writing or publishing", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const input = yield* digInSource(sessions);
      const child = yield* sessions.digIn(input);
      const copied = {
        history: (yield* sessions.listMessages({
          sessionID: child.id,
          limit: Number.MAX_SAFE_INTEGER,
        })).items,
      };
      const other = yield* sessions.create();
      const before = yield* sessions.list({ limit: 20 });
      published.length = 0;
      for (const invalid of [
        { ...input, sessionID: SessionId.make("ses_missing") },
        { ...input, sessionID: other.id },
        { ...input, messageID: "missing" },
        { ...input, messageID: "msg_001_question" },
        ...["missing", "prt_question", "prt_reasoning", "prt_synthetic"].map(
          (partId) => ({
            ...input,
            selection: { ...input.selection, partId },
          }),
        ),
        {
          ...input,
          sessionID: child.id,
          messageID: copied.history[1]!.info.id,
          selection: {
            ...input.selection,
            partId: copied.history[1]!.parts[0]!.id,
          },
        },
      ])
        expect(
          Exit.isFailure(yield* sessions.digIn(invalid).pipe(Effect.exit)),
        ).toBe(true);
      expect(
        yield* sessions
          .fork({ sessionID: child.id, messageID: copied.history[1]!.info.id })
          .pipe(Effect.flip),
      ).toBeInstanceOf(BranchUnavailable);
      expect(yield* sessions.list({ limit: 20 })).toEqual(before);
      expect(published).toEqual([]);
    }),
  );
});

test("rolls back child and copied history when the parent anchor cannot be saved", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const input = yield* digInSource(sessions);
      const before = yield* sessions.readTranscriptPage({
        sessionID: input.sessionID,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      published.length = 0;
      const update = vi
        .spyOn(sessionStore, "update")
        .mockImplementationOnce(() =>
          Effect.fail(
            new StoreNotFound({ entity: "session", id: input.sessionID }),
          ),
        );
      try {
        expect(
          Exit.isFailure(yield* sessions.digIn(input).pipe(Effect.exit)),
        ).toBe(true);
      } finally {
        update.mockRestore();
      }
      expect((yield* sessions.list({ limit: 20 })).items).toHaveLength(1);
      expect(
        yield* sessions.readTranscriptPage({
          sessionID: input.sessionID,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual(before);
      expect(published).toEqual([]);
      const child = yield* sessions.digIn(input);
      expect(
        (yield* sessions.listMessages({
          sessionID: child.id,
          limit: Number.MAX_SAFE_INTEGER,
        })).items,
      ).toHaveLength(2);
    }),
  );
});
