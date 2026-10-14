// Purpose: Locks transcript event ordering, step atomicity, routing, and committed snapshots.

import { create } from "./create";
import { createMessage } from "./create-message";
import { createPart } from "./create-part";
import { finishStep } from "./finish-step";
import { get } from "./get";
import { getMessage } from "./get-message";
import { getPart } from "./get-part";
import { listMessages } from "./list-messages";
import { updateMessage } from "./update-message";
import { updatePart } from "./update-part";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import * as Agui from "@openchart/server/agent/publisher/agui/adapter";
import { SessionId } from "@openchart/server/agent/contracts/session";
import type * as MessageInfo from "@openchart/server/agent/contracts/message";
import type {
  StepFinishPart,
  TextPart,
} from "@openchart/server/agent/contracts/part";
import { EventType } from "@ag-ui/core";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import {
  projectMessage,
  userMessageEvents,
} from "@openchart/server/agent/publisher/agui/projection";
import { Session as SessionService } from "@openchart/server/agent/session";
import {
  agentMessages,
  agentParts,
  agentSessions,
} from "@openchart/server/agent/schema";
import { Database } from "@openchart/server/db";
import { EventDefinition, Events } from "@openchart/server/events";
import { eq, sql } from "drizzle-orm";
import { Effect, Exit, Fiber, Layer, Schema, Stream } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";

import { messageStore } from "@openchart/server/agent/session/message/store";

const tokens = {
  input: 1,
  output: 2,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
function user(id: string, sessionID = "ses_session"): MessageInfo.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 10 },
    agent: "analyst",
    model: { providerID: "openai", modelID: "test" },
  };
}
function assistant(id = "assistant"): MessageInfo.Assistant {
  return {
    id,
    sessionID: "ses_session",
    role: "assistant",
    time: { created: 20 },
    triggeringUserMessageID: "user",
    providerID: "openai",
    modelID: "test",
    agent: "analyst",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens,
  };
}
function text(id: string, messageID: string, value = id): TextPart {
  return { id, messageID, type: "text", text: value, time: { start: 10 } };
}
function step(id = "step", messageID = "assistant"): StepFinishPart {
  return {
    id,
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 1,
    tokens,
  };
}

function native(event: unknown) {
  return Schema.decodeUnknownSync(AgentEvent)(event).data.event;
}

function run<A, E>(
  program: (
    published: EventDefinition.Payload[],
  ) => Effect.Effect<
    A,
    E,
    | Database.Service
    | Events.Service
    | Publisher.Service
    | SessionService.Service
  >,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* Events.Service;
      yield* create({ id: SessionId.make("ses_session") });
      yield* create({ id: SessionId.make("ses_other-session") });
      const published: EventDefinition.Payload[] = [];
      const checked: Events.Interface = {
        ...events,
        publish: (definition, data, options) =>
          Effect.gen(function* () {
            const event = yield* events.publish(definition, data, options);
            published.push(event);
            return event;
          }),
      };
      return yield* program(published).pipe(
        Effect.provide(Layer.fresh(Agui.layer)),
        Effect.provideService(Events.Service, checked),
      );
    }).pipe(
      Effect.provide(Layer.fresh(Agui.layer)),
      Effect.provide(
        Layer.mergeAll(
          SessionService.layer,
          Database.layer(":memory:", () => Effect.void),
          Events.layer,
        ),
      ),
    ),
  );
}

describe("Message operations", () => {
  test("generic Part batches commit together, preserve order, and publish no failed writes", async () => {
    await run(() =>
      Effect.gen(function* () {
        const session = yield* SessionService.Service;
        const publisher = yield* Publisher.Service;
        const database = yield* Database.Service;
        yield* session.createMessage({ info: user("user"), parts: [] });
        const observed: string[][] = [];
        const publicationOrder: string[] = [];
        const checked: Publisher.Interface = {
          ...publisher,
          publish: (change) =>
            Effect.gen(function* () {
              if (change.type === "part.updated") {
                const saved = yield* session
                  .getMessage({
                    sessionID: "ses_session",
                    messageID: "user",
                  })
                  .pipe(
                    Effect.provideService(Database.Service, database),
                    Effect.orDie,
                  );
                observed.push(saved!.parts.map((part) => part.id));
                publicationOrder.push(change.part.id);
              }
              yield* publisher.publish(change);
            }),
        };
        yield* Effect.gen(function* () {
          expect(yield* session.createParts([])).toEqual([]);
          expect(
            Exit.isFailure(
              yield* session
                .createParts([
                  text("duplicate", "user"),
                  text("duplicate", "user"),
                ])
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          expect(
            Exit.isFailure(
              yield* session
                .createParts([
                  text("rollback", "user"),
                  text("orphan", "missing"),
                ])
                .pipe(Effect.exit),
            ),
          ).toBe(true);
          expect(
            (yield* session.getMessage({
              sessionID: "ses_session",
              messageID: "user",
            }))!.parts,
          ).toEqual([]);
          expect(observed).toEqual([]);
          const parts = [text("b", "user"), text("a", "user")];
          const saved = yield* session.createParts(parts);
          expectTypeOf(saved).toEqualTypeOf<TextPart[]>();
          expect(saved).toEqual(parts);
          expect(publicationOrder).toEqual(["b", "a"]);
          expect(observed).toEqual([
            ["a", "b"],
            ["a", "b"],
          ]);
        }).pipe(Effect.provideService(Publisher.Service, checked));
      }),
    );
  });

  test("commits complete aggregates before appending the native user message with sorted Parts", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const sessionID = SessionId.make("ses_session");
        yield* db.transaction((tx) =>
          tx
            .update(agentSessions)
            .set({ updatedAt: 1 })
            .where(eq(agentSessions.id, sessionID)),
        );
        const before = yield* get(sessionID);
        const info = user("user");
        const saved = yield* createMessage({
          info,
          parts: [text("z", info.id), text("a", info.id)],
        });
        const after = yield* get(sessionID);
        expect(after).toEqual({ ...before, updatedAt: expect.any(Number) });
        expect(after?.updatedAt).toBeGreaterThan(1);
        expect(published).toHaveLength(5);
        expect(native(published[4])).toEqual({
          type: EventType.STATE_DELTA,
          delta: [{ op: "add", path: "/session", value: after }],
        });
        expect(native(published[0])).toEqual({
          type: EventType.STATE_DELTA,
          delta: [
            {
              op: "add",
              path: `/messageInfo/${info.id}`,
              value: { model: info.model, workspaceId: info.workspaceId },
            },
          ],
        });
        expect(published.slice(1, 4).map(native)).toEqual(
          userMessageEvents(saved),
        );
        // Parts are sorted by ID before projection.
        expect(native(published[2])).toMatchObject({
          type: EventType.TEXT_MESSAGE_CONTENT,
          delta: "a\nz",
        });
        expect(
          yield* getMessage({ sessionID: "ses_session", messageID: info.id }),
        ).toEqual(saved);
        expect(
          yield* getMessage({
            sessionID: "ses_other-session",
            messageID: info.id,
          }),
        ).toBeUndefined();
        const page = yield* listMessages({
          sessionID: "ses_session",
          limit: 1,
        });
        expect(page).toEqual({ items: [saved], nextCursor: null });
        expect(
          yield* getPart({
            sessionID: "ses_session",
            messageID: info.id,
            partID: "z",
          }),
        ).toEqual(text("z", info.id));
        expect(published).toHaveLength(5);
        const savedText = saved.parts[0];
        if (savedText?.type === "text") savedText.text = "caller mutation";
        expect(native(published[2])).toMatchObject({ delta: "a\nz" });
      }),
    );
  });

  test("updates Message headers and derives Part event routing from the saved owner", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const info = user("user", "ses_other-session");
        yield* createMessage({ info, parts: [] });
        published.length = 0;
        const updated = yield* updateMessage({ ...info, agent: "reviewer" });
        expectTypeOf(updated).toEqualTypeOf<MessageInfo.User>();
        expect(published).toEqual([]);
        const created = yield* createPart(text("part", info.id, "first"));
        expectTypeOf(created).toEqualTypeOf<TextPart>();
        const saved = yield* updatePart({
          ...created,
          text: "last",
          time: { start: 10, end: 20 },
        });
        expectTypeOf(saved).toEqualTypeOf<TextPart>();
        expect(published.map((event) => native(event).type)).toEqual([
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_DELTA,
          EventType.MESSAGES_SNAPSHOT,
          EventType.STATE_DELTA,
        ]);
        expect(
          published.map(
            (event) => (event.data as { sessionID: string }).sessionID,
          ),
        ).toEqual([
          "ses_other-session",
          "ses_other-session",
          "ses_other-session",
          "ses_other-session",
        ]);
        expect(native(published[0])).toMatchObject({
          messages: projectMessage({ info: updated, parts: [created] }),
        });
        expect(native(published[2])).toMatchObject({
          messages: projectMessage({ info: updated, parts: [saved] }),
        });
        expect(saved).not.toHaveProperty("sessionID");
      }),
    );
  });

  test("failed aggregate inserts and immutable-owner updates publish nothing", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const sessionID = SessionId.make("ses_session");
        const before = yield* get(sessionID);
        const bad = yield* Effect.exit(
          createMessage({
            info: user("bad"),
            parts: [text("duplicate", "bad"), text("duplicate", "bad")],
          }),
        );
        expect(Exit.isFailure(bad)).toBe(true);
        expect(
          yield* getMessage({ sessionID: "ses_session", messageID: "bad" }),
        ).toBeUndefined();
        expect(published).toEqual([]);
        expect(yield* get(sessionID)).toEqual(before);

        const original = yield* createMessage({
          info: user("user"),
          parts: [text("part", "user")],
        });
        yield* createMessage({ info: user("other"), parts: [] });
        published.length = 0;
        const exits: Exit.Exit<unknown, unknown>[] = [
          yield* Effect.exit(updateMessage(user("missing"))),
          yield* Effect.exit(
            updateMessage({
              ...original.info,
              sessionID: "ses_other-session",
            }),
          ),
          yield* Effect.exit(createPart(text("part", "user"))),
          yield* Effect.exit(updatePart(text("part", "other"))),
          yield* Effect.exit(updatePart(text("missing", "user"))),
        ];
        expect(exits.every(Exit.isFailure)).toBe(true);
        expect(
          yield* getMessage({ sessionID: "ses_session", messageID: "user" }),
        ).toEqual(original);
        expect(published).toEqual([]);
      }),
    );
  });

  test("rolls back the Message and Parts when touching its Session fails", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const sessionID = SessionId.make("ses_session");
        const before = yield* get(sessionID);
        yield* db.transaction((tx) =>
          tx.run(sql`
          CREATE TEMP TRIGGER reject_session_touch BEFORE UPDATE ON agent_sessions
          BEGIN SELECT RAISE(ABORT, 'test: reject Session update'); END
        `),
        );
        const failed = yield* Effect.exit(
          createMessage({
            info: user("user"),
            parts: [text("part", "user")],
          }),
        );
        expect(Exit.isFailure(failed)).toBe(true);
        expect(
          yield* getMessage({ sessionID, messageID: "user" }),
        ).toBeUndefined();
        expect(yield* db.select().from(agentParts)).toEqual([]);
        expect(yield* get(sessionID)).toEqual(before);
        expect(published).toEqual([]);
      }),
    );
  });

  test("finishStep commits both rows before publishing native step and header updates", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const info = assistant();
        yield* createMessage({ info, parts: [] });
        published.length = 0;
        const complete = {
          ...info,
          finish: "stop",
          time: { ...info.time, completed: 30 },
          cost: 1,
        };
        const saved = yield* finishStep({
          message: complete,
          part: step(),
        });
        expectTypeOf(saved.message).toEqualTypeOf<MessageInfo.Assistant>();
        expectTypeOf(saved.part).toEqualTypeOf<StepFinishPart>();
        expect(saved).toEqual({ message: complete, part: step() });
        expect(
          yield* getMessage({ sessionID: "ses_session", messageID: info.id }),
        ).toEqual({ info: complete, parts: [step()] });
        expect(published).toHaveLength(2);
        expect(native(published[0])).toEqual({
          type: EventType.STEP_FINISHED,
          stepName: info.id,
          metadata: { usage: tokens, cost: 1 },
        });
        expect(native(published[1])).toEqual({
          type: EventType.STATE_DELTA,
          delta: [
            {
              op: "add",
              path: "/messageInfo/assistant",
              value: {
                workspaceRoot: "/tmp",
                completedAt: 30,
                error: null,
                finish: "stop",
                cost: 1,
                tokens,
              },
            },
          ],
        });
      }),
    );
  });

  test("finishStep rolls back the header when marker insertion fails and rejects mismatched ownership", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const info = assistant();
        const original = yield* createMessage({
          info,
          parts: [text("taken", info.id)],
        });
        published.length = 0;
        const complete = {
          ...info,
          finish: "stop",
          time: { ...info.time, completed: 30 },
        };
        const duplicate = yield* Effect.exit(
          finishStep({ message: complete, part: step("taken") }),
        );
        const mismatched = yield* Effect.exit(
          finishStep({ message: complete, part: step("new", "other") }),
        );
        expect([duplicate, mismatched].every(Exit.isFailure)).toBe(true);
        expect(
          yield* getMessage({ sessionID: "ses_session", messageID: info.id }),
        ).toEqual(original);
        expect(published).toEqual([]);
      }),
    );
  });

  test.each([NaN, Infinity, -Infinity])(
    "finishStep rejects non-finite usage or cost %s without committing or publishing",
    async (value) => {
      await run((published) =>
        Effect.gen(function* () {
          const info = assistant();
          const original = yield* createMessage({ info, parts: [] });
          published.length = 0;
          const complete = { ...info, time: { ...info.time, completed: 30 } };
          const marker = step();
          for (const input of [
            { message: { ...complete, cost: value }, part: marker },
            {
              message: { ...complete, tokens: { ...tokens, input: value } },
              part: marker,
            },
            { message: complete, part: { ...marker, cost: value } },
            {
              message: complete,
              part: { ...marker, tokens: { ...tokens, input: value } },
            },
          ]) {
            const exit = yield* Effect.exit(finishStep(input));
            expect(Exit.isFailure(exit)).toBe(true);
            expect(
              yield* getMessage({
                sessionID: info.sessionID,
                messageID: info.id,
              }),
            ).toEqual(original);
            expect(published).toEqual([]);
          }
        }),
      );
    },
  );

  test("rolls back a Part write if its owning Message cannot be decoded for event routing", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* createMessage({ info: user("user"), parts: [] });
        published.length = 0;
        yield* db
          .update(agentMessages)
          .set({ data: sql`'{}'` })
          .where(eq(agentMessages.id, "user"));
        const exit = yield* Effect.exit(createPart(text("part", "user")));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* db.select().from(agentParts)).toEqual([]);
        expect(
          yield* db.transaction((tx) => messageStore.getInfo(tx, "missing")),
        ).toBeUndefined();
        expect(published).toEqual([]);
      }),
    );
  });

  test("Part writes publish detached snapshots matching committed storage", async () => {
    await run(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const info = user("user");
          yield* createMessage({ info, parts: [] });
          const events = yield* Events.Service;
          const live = yield* events.allBounded(256);
          const subscriber = yield* live.pipe(
            Stream.filter(
              (event): event is typeof AgentEvent.Type =>
                event.type === AgentEvent.type,
            ),
            Stream.filter(
              (event) => event.data.event.type === EventType.MESSAGES_SNAPSHOT,
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          );
          const part = text("part", info.id, "first");
          const first = yield* createPart(part);
          part.text = "second";
          part.time = { start: 10, end: 20 };
          const second = yield* updatePart(part);
          part.text = "mutated";
          const delivered = Array.from(yield* Fiber.join(subscriber));
          expect(delivered.map((event) => event.data.event)).toEqual([
            {
              type: EventType.MESSAGES_SNAPSHOT,
              messages: projectMessage({ info, parts: [first] }),
            },
            {
              type: EventType.MESSAGES_SNAPSHOT,
              messages: projectMessage({ info, parts: [second] }),
            },
          ]);
          expect(first.text).toBe("first");
          expect(second).toMatchObject({
            text: "second",
            time: { start: 10, end: 20 },
          });
          expect(
            yield* getPart({
              sessionID: info.sessionID,
              messageID: info.id,
              partID: part.id,
            }),
          ).toEqual(second);
        }),
      ),
    );
  });
});
