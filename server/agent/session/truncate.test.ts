// Purpose: Locks truncation ownership, storage ordering, atomic cleanup and idle-only execution.
import type {
  Assistant,
  User,
} from "@openchart/server/agent/contracts/message";
import { SessionId } from "@openchart/server/agent/contracts/session";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { agentMessages, agentParts } from "@openchart/server/agent/schema";
import { Session } from "@openchart/server/agent/session";
import {
  SessionBusy,
  TruncateUnavailable,
} from "@openchart/server/agent/session/errors";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { eq, sql } from "drizzle-orm";
import { Effect, Exit, Layer } from "effect";
import { expect, test } from "vitest";

function run<A, E>(
  program: (
    published: Publisher.Change[],
  ) => Effect.Effect<
    A,
    E,
    | Session.Service
    | AgentRunStore.Service
    | Database.Service
    | Events.Service
    | Publisher.Service
  >,
) {
  const published: Publisher.Change[] = [];
  const dependencies = Layer.mergeAll(
    Session.layer,
    Database.layer(":memory:", () => Effect.void),
    Events.layer,
    Layer.succeed(Publisher.Service, {
      publish: (change) =>
        Effect.sync(() => {
          published.push(structuredClone(change));
        }),
    }),
  );
  // Deliberately no SessionExecution/Prompt service: preparation cannot trigger work.
  return Effect.runPromise(
    program(published).pipe(
      Effect.provide(
        AgentRunStore.layer.pipe(Layer.provideMerge(dependencies)),
      ),
    ),
  );
}

const turn = Effect.fn("test.turn")(function* (
  sessionID: SessionId,
  prefix: string,
  position: number,
) {
  const sessions = yield* Session.Service;
  const { db } = yield* Database.Service;
  const user: User = {
    id: `msg_${prefix}_user`,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "analyst",
    model: { providerID: "codex" as const, modelID: "tier1" as const },
  };
  const assistant: Assistant = {
    id: `msg_${prefix}_assistant`,
    sessionID,
    role: "assistant",
    triggeringUserMessageID: user.id,
    time: { created: 1, completed: 2 },
    finish: "stop",
    agent: "analyst",
    providerID: "test",
    modelID: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  for (const info of [user, assistant])
    yield* sessions.createMessage({
      info,
      parts: [
        {
          id: `prt_${info.id}`,
          messageID: info.id,
          type: "text",
          text: info.id,
        },
      ],
    });
  yield* db.transaction((tx) =>
    Effect.gen(function* () {
      yield* tx
        .update(agentMessages)
        .set({ createdAt: position })
        .where(eq(agentMessages.id, user.id));
      yield* tx
        .update(agentMessages)
        .set({ createdAt: position + 1 })
        .where(eq(agentMessages.id, assistant.id));
    }),
  );
  return { user, assistant };
});

const acceptedRun = Effect.fn("test.acceptedRun")(function* (
  sessionID: string,
) {
  const runs = yield* AgentRunStore.Service;
  return yield* runs.enqueue({
    sessionID,
    sessionIntentID: `intent_${sessionID}`,
    input: {
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
      parts: [{ type: "text", text: "original" }],
    },
  });
});

test("retains inclusive storage order and identities, cascades Parts, cleans anchors and preserves children/Runs", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const runs = yield* AgentRunStore.Service;
      const { db } = yield* Database.Service;
      const source = yield* sessions.getOrCreateBound({
        kind: "chat",
        key: "truncate-test",
        title: "Keep title",
      });
      const first = yield* turn(source.id, "a", 10);
      // Equal SQL timestamps use IDs; content timestamps and ID-only ordering differ.
      const second = yield* turn(source.id, "b", 11);
      const children = [];
      for (const message of [first.assistant, second.assistant])
        children.push(
          yield* sessions.digIn({
            sessionID: source.id,
            messageID: message.id,
            selection: {
              partId: `prt_${message.id}`,
              text: "selected",
              startOffset: 0,
              endOffset: 8,
            },
          }),
        );
      const original = yield* sessions.readTranscriptPage({
        sessionID: source.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      const childrenBefore = yield* Effect.forEach(children, (child) =>
        sessions.listMessages({
          sessionID: child.id,
          limit: Number.MAX_SAFE_INTEGER,
        }),
      );
      const accepted = yield* acceptedRun(source.id);
      yield* runs.claim(source.id);
      yield* runs.complete(accepted.id);
      const runsBefore = yield* runs.list(source.id);
      published.length = 0;

      expect(
        yield* sessions.truncate({
          sessionID: source.id,
          messageID: first.assistant.id,
        }),
      ).toBeUndefined();
      const saved = yield* sessions.readTranscriptPage({
        sessionID: source.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      expect(saved.history).toEqual(original.history.slice(0, 2));
      expect(saved.session).toMatchObject({
        ...source,
        updatedAt: expect.any(Number),
        anchors: [original.session.anchors![0]],
      });
      expect(yield* runs.list(source.id)).toEqual(runsBefore);
      expect(
        yield* Effect.forEach(children, (child) =>
          sessions.listMessages({
            sessionID: child.id,
            limit: Number.MAX_SAFE_INTEGER,
          }),
        ),
      ).toEqual(childrenBefore);
      expect(
        yield* db
          .select()
          .from(agentParts)
          .where(eq(agentParts.messageId, second.user.id)),
      ).toEqual([]);
      expect(
        yield* db
          .select()
          .from(agentParts)
          .where(eq(agentParts.messageId, second.assistant.id)),
      ).toEqual([]);
      expect(published).toEqual([
        { type: "session.updated", session: saved.session },
        { type: "transcript.updated", sessionID: source.id },
      ]);
      expect(
        (yield* sessions.getOrCreateBound({
          kind: "chat",
          key: "truncate-test",
        })).id,
      ).toBe(source.id);

      // Retained boundaries remain valid for a retry before another submission.
      yield* sessions.truncate({
        sessionID: source.id,
        messageID: first.assistant.id,
      });
      expect(
        (yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history,
      ).toEqual(saved.history);
    }),
  );
});

test("null clears only the selected main thread and can be repeated", async () => {
  await run(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const source = yield* sessions.create();
      const other = yield* sessions.create();
      yield* turn(source.id, "source", 10);
      yield* turn(other.id, "other", 10);
      const otherBefore = yield* sessions.readTranscriptPage({
        sessionID: other.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      yield* sessions.truncate({ sessionID: source.id, messageID: null });
      yield* sessions.truncate({ sessionID: source.id, messageID: null });
      expect(
        (yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history,
      ).toEqual([]);
      expect(
        yield* sessions.readTranscriptPage({
          sessionID: other.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual(otherBefore);
    }),
  );
});

test("finds a boundary across complete storage pages", async () => {
  await run(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const source = yield* sessions.create();
      const first = yield* turn(source.id, "000", 10);
      for (let i = 1; i <= 51; i++)
        yield* turn(source.id, String(i).padStart(3, "0"), 10 + i * 2);
      expect(
        (yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history,
      ).toHaveLength(104);
      yield* sessions.truncate({
        sessionID: source.id,
        messageID: first.assistant.id,
      });
      expect(
        (yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        })).history.map(({ info }) => info.id),
      ).toEqual([first.user.id, first.assistant.id]);
    }),
  );
});

test("rejects missing, foreign, user and unfinished boundaries without writes or publication", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const source = yield* sessions.create();
      const other = yield* sessions.create();
      const first = yield* turn(source.id, "a", 10);
      const unfinished = { ...first.assistant, time: { created: 1 } };
      yield* sessions.updateMessage(unfinished);
      const before = yield* sessions.readTranscriptPage({
        sessionID: source.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      published.length = 0;
      for (const [input, error] of [
        [
          { sessionID: SessionId.make("ses_missing"), messageID: null },
          StoreNotFound,
        ],
        [{ sessionID: other.id, messageID: first.assistant.id }, StoreNotFound],
        [{ sessionID: source.id, messageID: "missing" }, StoreNotFound],
        [
          { sessionID: source.id, messageID: first.user.id },
          TruncateUnavailable,
        ],
        [
          { sessionID: source.id, messageID: first.assistant.id },
          TruncateUnavailable,
        ],
      ] as const) {
        const failure = yield* sessions.truncate(input).pipe(Effect.flip);
        expect(failure).toBeInstanceOf(error);
      }
      expect(
        yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual(before);
      expect(published).toEqual([]);
    }),
  );
});

test.each(["delegate", "dig_in", "scheduled"] as const)(
  "rejects %s Sessions even for null boundaries",
  async (kind) => {
    await run((published) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service;
        const source = yield* sessions.create({ kind });
        const before = yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        });
        published.length = 0;
        expect(
          yield* sessions
            .truncate({ sessionID: source.id, messageID: null })
            .pipe(Effect.flip),
        ).toBeInstanceOf(TruncateUnavailable);
        expect(
          yield* sessions.readTranscriptPage({
            sessionID: source.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          }),
        ).toEqual(before);
        expect(published).toEqual([]);
      }),
    );
  },
);

test.each(["queued", "running"] as const)(
  "rejects a Session with %s work without altering its queue or history",
  async (status) => {
    await run((published) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service;
        const runs = yield* AgentRunStore.Service;
        const source = yield* sessions.create();
        const first = yield* turn(source.id, "a", 10);
        yield* acceptedRun(source.id);
        if (status === "running") yield* runs.claim(source.id);
        const before = yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        });
        const queue = yield* runs.list(source.id);
        published.length = 0;
        for (const messageID of [null, first.assistant.id])
          expect(
            yield* sessions
              .truncate({ sessionID: source.id, messageID })
              .pipe(Effect.flip),
          ).toBeInstanceOf(SessionBusy);
        expect(
          yield* sessions.readTranscriptPage({
            sessionID: source.id,
            turnLimit: Number.MAX_SAFE_INTEGER,
          }),
        ).toEqual(before);
        expect(yield* runs.list(source.id)).toEqual(queue);
        expect(published).toEqual([]);
      }),
    );
  },
);

test("rolls deleted messages and Parts back when the Session update fails, with no publication", async () => {
  await run((published) =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const { db } = yield* Database.Service;
      const source = yield* sessions.create();
      yield* turn(source.id, "a", 10);
      const before = yield* sessions.readTranscriptPage({
        sessionID: source.id,
        turnLimit: Number.MAX_SAFE_INTEGER,
      });
      yield* db.transaction((tx) =>
        tx.run(
          sql`CREATE TEMP TRIGGER reject_truncate BEFORE UPDATE ON agent_sessions BEGIN SELECT RAISE(ABORT, 'injected'); END`,
        ),
      );
      published.length = 0;
      expect(
        Exit.isFailure(
          yield* sessions
            .truncate({ sessionID: source.id, messageID: null })
            .pipe(Effect.exit),
        ),
      ).toBe(true);
      expect(
        yield* sessions.readTranscriptPage({
          sessionID: source.id,
          turnLimit: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual(before);
      expect(published).toEqual([]);
    }),
  );
});
