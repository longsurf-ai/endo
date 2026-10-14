// Purpose: Locks Message/Part persistence, ownership, complete pagination, and cross-store atomicity.

import { SessionId } from "@openchart/server/agent/contracts/session";
import type * as Message from "@openchart/server/agent/contracts/message";
import * as Part from "@openchart/server/agent/contracts/part";
import {
  type SessionStore,
  sessionStore as sessions,
} from "@openchart/server/agent/session/store";
import {
  agentMessages,
  agentParts,
  agentSessions,
} from "@openchart/server/agent/schema";
import { Database } from "@openchart/server/db";
import { eq, sql } from "drizzle-orm";
import { Effect, Exit, Schema } from "effect";
import { describe, expect, test } from "vitest";
import { type MessageStore, messageStore as store } from "./store";
import * as Data from "./data";

const tokens = {
  input: 1,
  output: 2,
  reasoning: 0,
  cache: { read: 0, write: 0 },
};
function user(id: string, sessionID = "ses_1"): Message.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 10 },
    agent: "analyst",
    model: { providerID: "openai", modelID: "gpt-5" },
  };
}
function assistant(id: string): Message.Assistant {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 20 },
    triggeringUserMessageID: "user",
    providerID: "openai",
    modelID: "gpt-5",
    agent: "analyst",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens,
  };
}
function text(id: string, messageID: string): Part.TextPart {
  return { id, messageID, type: "text", text: id, time: { start: 10 } };
}
function session(id: string): SessionStore.InsertInput {
  return {
    id: SessionId.make(id),
    parentId: null,
    kind: "chat",
    bindingId: null,
    anchors: null,
    title: id,
    compactingAt: null,
    archivedAt: null,
  };
}
function run<A, E>(program: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* sessions.insert(tx, session("ses_1"));
          yield* sessions.insert(tx, session("ses_2"));
        }),
      );
      return yield* program;
    }).pipe(Effect.provide(Database.layer(":memory:", () => Effect.void))),
  );
}

describe("MessageStore turn pages", () => {
  test.each(["chat", "dig_in", "delegate", "scheduled"] as const)(
    "has identical complete history at every positive page size for %s",
    async (kind) => {
      await run(
        Effect.gen(function* () {
          const { db } = yield* Database.Service;
          yield* db
            .update(agentSessions)
            .set({ kind })
            .where(eq(agentSessions.id, "ses_1"));
          for (let n = 0; n < 13; n++) {
            const id = `msg_${String(n).padStart(3, "0")}`;
            yield* db.transaction((tx) =>
              store.insert(tx, {
                info: user(id),
                parts: [
                  text(`${id}_text`, id),
                  ...(kind === "dig_in" && n === 1
                    ? [
                        {
                          id: "marker",
                          messageID: id,
                          type: "context" as const,
                          context: {
                            kind: "dig_in" as const,
                            quoteText: "Selected",
                          },
                        },
                      ]
                    : []),
                ],
              }),
            );
            yield* db.transaction((tx) =>
              store.insert(tx, {
                info: {
                  ...assistant(`${id}_reply`),
                  triggeringUserMessageID: id,
                },
                parts: [text(`${id}_reply_text`, `${id}_reply`)],
              }),
            );
          }
          yield* db.update(agentMessages).set({ createdAt: 500 });
          const expected = (yield* db.transaction((tx) =>
            store.list(tx, { sessionID: "ses_1", limit: 100 }),
          )).items.slice(kind === "dig_in" ? 2 : 0);
          // Include every size around the data boundary, the former cap, and the safe integer maximum.
          for (const turnLimit of [
            ...Array.from({ length: 15 }, (_, n) => n + 1),
            100,
            101,
            1000,
            Number.MAX_SAFE_INTEGER,
          ]) {
            let cursor: string | undefined;
            let loaded: Message.WithParts[] = [];
            do {
              const page = yield* db.transaction((tx) =>
                store.listTurns(tx, {
                  sessionID: "ses_1",
                  turnLimit,
                  ...(cursor ? { cursor } : {}),
                }),
              );
              expect(
                page.items.filter(({ info }) => info.role === "user").length,
              ).toBeLessThanOrEqual(turnLimit);
              loaded = [...page.items, ...loaded];
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
            expect(loaded).toEqual(expected);
          }
        }),
      );
    },
  );

  test.each(["duplicate", "assistant"] as const)(
    "rejects a %s Dig In visibility marker at the read owner",
    async (invalid) => {
      await run(
        Effect.gen(function* () {
          const { db } = yield* Database.Service;
          yield* db
            .update(agentSessions)
            .set({ kind: "dig_in" })
            .where(eq(agentSessions.id, "ses_1"));
          yield* db.transaction((tx) =>
            store.insert(tx, {
              info:
                invalid === "assistant"
                  ? assistant("marker_message")
                  : user("marker_message"),
              parts: Array.from(
                { length: invalid === "duplicate" ? 2 : 1 },
                (_, n) => ({
                  id: `marker_${n}`,
                  messageID: "marker_message",
                  type: "context" as const,
                  context: { kind: "dig_in" as const, quoteText: "Selected" },
                }),
              ),
            }),
          );
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                db.transaction((tx) =>
                  store.listTurns(tx, { sessionID: "ses_1", turnLimit: 1 }),
                ),
              ),
            ),
          ).toBe(true);
        }),
      );
    },
  );

  test("keeps whole turns and Parts across equal timestamps, new tail writes, and a deleted cursor", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const turns: string[][] = [];
        for (let turn = 0; turn < 4; turn++) {
          const ids = [
            `${turn}_0_user`,
            ...Array.from(
              { length: turn === 2 ? 125 : 2 },
              (_, n) => `${turn}_1_${String(n).padStart(3, "0")}`,
            ),
          ];
          turns.push(ids);
          for (const [index, id] of ids.entries()) {
            yield* db.transaction((tx) =>
              store.insert(tx, {
                info:
                  index === 0
                    ? user(id)
                    : { ...assistant(id), triggeringUserMessageID: ids[0]! },
                parts: [text(`${id}_a`, id), text(`${id}_b`, id)],
              }),
            );
          }
        }
        yield* db.update(agentMessages).set({ createdAt: 500 });
        const page = (cursor?: string) =>
          db.transaction((tx) =>
            store.listTurns(tx, {
              sessionID: "ses_1",
              turnLimit: 1,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
        const first = yield* page();
        expect(first.items.map(({ info }) => info.id)).toEqual(turns[3]);
        expect(first.nextCursor).not.toBeNull();
        yield* db.transaction((tx) =>
          store.insert(tx, { info: user("4_0_user"), parts: [] }),
        );
        const second = yield* page(first.nextCursor!);
        expect(second.items.map(({ info }) => info.id)).toEqual(turns[2]);
        expect(second.items.every(({ parts }) => parts.length === 2)).toBe(
          true,
        );
        const third = yield* page(second.nextCursor!);
        const last = yield* page(third.nextCursor!);
        expect(third.items.map(({ info }) => info.id)).toEqual(turns[1]);
        expect(last.items.map(({ info }) => info.id)).toEqual(turns[0]);
        expect(last.nextCursor).toBeNull();
        yield* db.transaction((tx) =>
          store.truncate(tx, {
            sessionID: "ses_1",
            messageID: turns[2]!.at(-1)!,
          }),
        );
        expect(yield* page(first.nextCursor!)).toEqual(second);
        for (const cursor of [
          "bad-cursor",
          Buffer.from(
            JSON.stringify({
              kind: "message",
              sessionID: "ses_1",
              id: "x",
              createdAt: 500,
            }),
          ).toString("base64url"),
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(page(cursor)))).toBe(true);
        }
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              db.transaction((tx) =>
                store.listTurns(tx, {
                  sessionID: "ses_2",
                  turnLimit: 1,
                  cursor: first.nextCursor!,
                }),
              ),
            ),
          ),
        ).toBe(true);
      }),
    );
  });

  test("only decodes Parts from selected turns", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        for (const id of ["0_user", "1_user"]) {
          yield* db.transaction((tx) =>
            store.insert(tx, {
              info: user(id),
              parts: [text(`${id}_text`, id)],
            }),
          );
        }
        yield* db.update(agentMessages).set({ createdAt: 500 });
        yield* db
          .update(agentParts)
          .set({ data: sql`json_set(${agentParts.data}, '$.text', 42)` })
          .where(eq(agentParts.id, "0_user_text"));
        const page = yield* db.transaction((tx) =>
          store.listTurns(tx, {
            sessionID: "ses_1",
            turnLimit: 1,
          }),
        );
        expect(page.items.map(({ info }) => info.id)).toEqual(["1_user"]);
        expect(page.nextCursor).not.toBeNull();
      }),
    );
  });

  test("Dig In pages stop at the marker even when the marker is outside the newest page", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const page = (cursor?: string) =>
          db.transaction((tx) =>
            store.listTurns(tx, {
              sessionID: "ses_1",
              turnLimit: 1,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
        yield* db
          .update(agentSessions)
          .set({ kind: "dig_in" })
          .where(eq(agentSessions.id, "ses_1"));
        yield* db.transaction((tx) =>
          store.insert(tx, {
            info: user("0_copied"),
            parts: [text("copied", "0_copied")],
          }),
        );
        expect(yield* page()).toEqual({ items: [], nextCursor: null });
        yield* db.transaction((tx) =>
          store.insert(tx, {
            info: user("1_marker"),
            parts: [
              {
                id: "marker",
                messageID: "1_marker",
                type: "context",
                context: { kind: "dig_in", quoteText: "Selected" },
              },
            ],
          }),
        );
        yield* db.transaction((tx) =>
          store.insert(tx, { info: user("2_next"), parts: [] }),
        );
        yield* db.update(agentMessages).set({ createdAt: 500 });
        const first = yield* page();
        expect(first.items.map(({ info }) => info.id)).toEqual(["2_next"]);
        const last = yield* page(first.nextCursor!);
        expect(last.items.map(({ info }) => info.id)).toEqual(["1_marker"]);
        expect(last.nextCursor).toBeNull();
      }),
    );
  });
});

describe("MessageStore", () => {
  test("round-trips both roles, empty aggregates, nested codecs, and canonical Part order", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const info = user("user");
        const parts = [
          text("z", info.id),
          Schema.decodeUnknownSync(Part.ContextPart)({
            id: "context",
            messageID: info.id,
            type: "context",
            context: {
              kind: "session",
              sessionId: "ses_source",
              throughCreatedAt: "2026-09-06T08:00:00+08:00",
            },
          }),
          text("a", info.id),
        ];
        const saved = yield* db.transaction((tx) =>
          store.insert(tx, { info, parts }),
        );
        expect(saved.info).toEqual(info);
        expect(saved.parts.map((part) => part.id)).toEqual([
          "a",
          "context",
          "z",
        ]);
        expect(saved.parts[1]).toMatchObject({
          context: { throughCreatedAt: "2026-09-06T00:00:00.000Z" },
        });
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { sessionID: info.sessionID, messageID: info.id }),
          ),
        ).toEqual(saved);
        const empty = yield* db.transaction((tx) =>
          store.insert(tx, { info: assistant("assistant"), parts: [] }),
        );
        expect(empty.parts).toEqual([]);
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { sessionID: "ses_1", messageID: "assistant" }),
          ),
        ).toEqual(empty);
        const rows = yield* db.select().from(agentParts);
        for (const row of rows) {
          expect(row.data).not.toHaveProperty("id");
          expect(row.data).not.toHaveProperty("messageID");
          expect(row.data).not.toHaveProperty("sessionID");
        }
        for (const row of yield* db.select().from(agentMessages)) {
          expect(row.data).not.toHaveProperty("id");
          expect(row.data).not.toHaveProperty("sessionID");
          expect(row.data).not.toHaveProperty("role");
          expect(row.createdAt).toBeGreaterThan(20);
        }
      }),
    );
  });

  test("scopes Message and Part reads through Message Session ownership", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db.transaction((tx) =>
          store.insert(tx, {
            info: user("message"),
            parts: [text("part", "message")],
          }),
        );
        const key = {
          sessionID: "ses_1",
          messageID: "message",
          partID: "part",
        };
        expect(yield* db.transaction((tx) => store.getPart(tx, key))).toEqual(
          text("part", "message"),
        );
        for (const other of [
          { ...key, sessionID: "ses_2" },
          { ...key, messageID: "missing" },
          { ...key, partID: "missing" },
        ]) {
          expect(
            yield* db.transaction((tx) => store.getPart(tx, other)),
          ).toBeUndefined();
        }
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { ...key, sessionID: "ses_2" }),
          ),
        ).toBeUndefined();
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { ...key, messageID: "missing" }),
          ),
        ).toBeUndefined();
      }),
    );
  });

  test("updates content without rewriting identity, SQL creation times, or unrelated Parts", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const info = assistant("message");
        yield* db.transaction((tx) =>
          store.insert(tx, { info, parts: [text("part", info.id)] }),
        );
        yield* db.update(agentMessages).set({ createdAt: 100, updatedAt: 1 });
        yield* db.update(agentParts).set({ createdAt: 200, updatedAt: 1 });
        const completed = {
          ...info,
          time: { ...info.time, completed: 30 },
          finish: "stop",
        };
        expect(
          yield* db.transaction((tx) => store.update(tx, completed)),
        ).toEqual(completed);
        const changed = {
          ...text("part", info.id),
          text: "Updated",
          time: { start: 10, end: 30 },
        };
        expect(
          yield* db.transaction((tx) => store.updatePart(tx, changed)),
        ).toEqual(changed);
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { sessionID: info.sessionID, messageID: info.id }),
          ),
        ).toEqual({ info: completed, parts: [changed] });
        const message = (yield* db.select().from(agentMessages).get())!;
        const part = (yield* db.select().from(agentParts).get())!;
        expect(message.createdAt).toBe(100);
        expect(part.createdAt).toBe(200);
        expect(message.updatedAt).toBeGreaterThan(200);
        expect(part.updatedAt).toBeGreaterThan(200);
      }),
    );
  });

  test("rejects missing writes, duplicate IDs, owner changes, and discriminant changes", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const original = yield* db.transaction((tx) =>
          store.insert(tx, {
            info: user("message"),
            parts: [text("part", "message")],
          }),
        );
        yield* db.transaction((tx) =>
          store.insert(tx, { info: user("other"), parts: [] }),
        );
        expect(
          yield* Effect.flip(
            db.transaction((tx) => store.update(tx, user("missing"))),
          ),
        ).toMatchObject({ _tag: "AgentStore.NotFound", entity: "message" });
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.updatePart(tx, text("missing", "message")),
            ),
          ),
        ).toMatchObject({ _tag: "AgentStore.NotFound", entity: "part" });
        const conflicts: Effect.Effect<unknown, MessageStore.StoreError>[] = [
          db.transaction((tx) => store.update(tx, user("message", "ses_2"))),
          db.transaction((tx) => store.update(tx, assistant("message"))),
          db.transaction((tx) => store.updatePart(tx, text("part", "other"))),
          db.transaction((tx) =>
            store.updatePart(tx, {
              ...text("part", "message"),
              type: "reasoning",
              time: { start: 10 },
            }),
          ),
          db.transaction((tx) =>
            store.insert(tx, {
              info: user("bad"),
              parts: [text("new", "other")],
            }),
          ),
        ];
        for (const conflict of conflicts)
          expect(yield* Effect.flip(conflict)).toMatchObject({
            _tag: "AgentStore.WriteConflict",
          });
        const duplicates: Effect.Effect<unknown, MessageStore.StoreError>[] = [
          db.transaction((tx) => store.insert(tx, original)),
          db.transaction((tx) => store.insertPart(tx, text("part", "message"))),
          db.transaction((tx) =>
            store.insertPart(tx, text("orphan", "missing")),
          ),
          db.transaction((tx) =>
            store.insert(tx, {
              info: user("orphan-message", "missing"),
              parts: [],
            }),
          ),
        ];
        for (const duplicate of duplicates)
          expect(Exit.isFailure(yield* Effect.exit(duplicate))).toBe(true);
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { sessionID: "ses_1", messageID: "message" }),
          ),
        ).toEqual(original);
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { sessionID: "ses_1", messageID: "bad" }),
          ),
        ).toBeUndefined();
      }),
    );
  });

  test("rolls back Session, Message, and initial Parts when one Part insert fails", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              db.transaction((tx) =>
                Effect.gen(function* () {
                  yield* sessions.insert(tx, session("new-session"));
                  yield* store.insert(tx, {
                    info: user("new-message", "new-session"),
                    parts: [
                      text("duplicate", "new-message"),
                      text("duplicate", "new-message"),
                    ],
                  });
                }),
              ),
            ),
          ),
        ).toBe(true);
        expect(
          yield* db.transaction((tx) => sessions.get(tx, "new-session")),
        ).toBeUndefined();
        expect(yield* db.select().from(agentMessages)).toEqual([]);
        expect(yield* db.select().from(agentParts)).toEqual([]);
      }),
    );
  });

  test("commits assistant completion and StepFinish together or rolls both back", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const info = assistant("message");
        const original = yield* db.transaction((tx) =>
          store.insert(tx, { info, parts: [text("part", info.id)] }),
        );
        const completed = {
          ...info,
          time: { ...info.time, completed: 30 },
          finish: "stop",
        };
        const finish: Part.StepFinishPart = {
          id: "part",
          messageID: info.id,
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens,
        };
        const complete = (part: Part.StepFinishPart) =>
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* store.update(tx, completed);
              yield* store.insertPart(tx, part);
            }),
          );
        expect(Exit.isFailure(yield* Effect.exit(complete(finish)))).toBe(true);
        expect(
          yield* db.transaction((tx) =>
            store.get(tx, { sessionID: info.sessionID, messageID: info.id }),
          ),
        ).toEqual(original);
        yield* complete({ ...finish, id: "finish" });
        const saved = yield* db.transaction((tx) =>
          store.get(tx, { sessionID: info.sessionID, messageID: info.id }),
        );
        expect(saved?.info).toEqual(completed);
        expect(saved?.parts.map((part) => part.type)).toEqual([
          "step-finish",
          "text",
        ]);
      }),
    );
  });

  test("paginates whole Messages by SQL time and ID while returning each page oldest-first", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        for (const id of ["a", "b", "c", "d"]) {
          yield* db.transaction((tx) =>
            store.insert(tx, {
              info: { ...user(id), time: { created: 1000 - id.charCodeAt(0) } },
              parts:
                id === "d"
                  ? ["5", "4", "3", "2", "1"].map((suffix) =>
                      text(`${id}-${suffix}`, id),
                    )
                  : [],
            }),
          );
        }
        yield* db.update(agentMessages).set({ createdAt: 100 });
        yield* db.transaction((tx) =>
          store.insert(tx, {
            info: user("other", "ses_2"),
            parts: [text("other-part", "other")],
          }),
        );
        const first = yield* db.transaction((tx) =>
          store.list(tx, { sessionID: "ses_1", limit: 2 }),
        );
        expect(first.items.map((item) => item.info.id)).toEqual(["c", "d"]);
        expect(first.items[1]!.parts.map((part) => part.id)).toEqual([
          "d-1",
          "d-2",
          "d-3",
          "d-4",
          "d-5",
        ]);
        yield* db.delete(agentMessages).where(eq(agentMessages.id, "c"));
        yield* db.transaction((tx) =>
          store.insert(tx, { info: user("new"), parts: [] }),
        );
        const second = yield* db.transaction((tx) =>
          store.list(tx, {
            sessionID: "ses_1",
            limit: 2,
            cursor: first.nextCursor!,
          }),
        );
        expect(second.items.map((item) => item.info.id)).toEqual(["a", "b"]);
        expect(second.nextCursor).toBeNull();
        expect(
          yield* db.transaction((tx) =>
            store.list(tx, { sessionID: "missing", limit: 2 }),
          ),
        ).toEqual({ items: [], nextCursor: null });
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.list(tx, {
                sessionID: "ses_2",
                limit: 2,
                cursor: first.nextCursor!,
              }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
      }),
    );
  });

  test("rejects malformed pagination and cursors belonging to a different Store", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        for (const limit of [
          0,
          -1,
          1.5,
          NaN,
          Infinity,
          Number.MAX_SAFE_INTEGER + 1,
        ]) {
          expect(
            yield* Effect.flip(
              db.transaction((tx) =>
                store.list(tx, { sessionID: "ses_1", limit }),
              ),
            ),
          ).toMatchObject({ _tag: "SchemaError" });
        }
        const page = yield* db.transaction((tx) =>
          sessions.list(tx, { limit: 1 }),
        );
        for (const cursor of ["", "not-a-cursor", "e30=", page.nextCursor!]) {
          expect(
            yield* Effect.flip(
              db.transaction((tx) =>
                store.list(tx, { sessionID: "ses_1", limit: 1, cursor }),
              ),
            ),
          ).toMatchObject({ _tag: "SchemaError" });
        }
      }),
    );
  });

  test("rejects malformed stored content and invalid encoded writes without changing rows", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const info = user("message");
        yield* db.transaction((tx) =>
          store.insert(tx, { info, parts: [text("part", info.id)] }),
        );
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.updatePart(tx, {
                ...text("part", info.id),
                time: { start: NaN },
              }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        expect(
          yield* db.transaction((tx) =>
            store.getPart(tx, {
              sessionID: info.sessionID,
              messageID: info.id,
              partID: "part",
            }),
          ),
        ).toEqual(text("part", info.id));
        yield* db.run(
          sql`UPDATE agent_messages SET data = '{"time":{"created":"corrupt"}}' WHERE id = 'message'`,
        );
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.get(tx, { sessionID: info.sessionID, messageID: info.id }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        yield* db
          .update(agentMessages)
          .set({ data: yield* Data.encodeInfo(info) })
          .where(eq(agentMessages.id, info.id));
        yield* db.run(
          sql`UPDATE agent_parts SET data = '{"type":"text","text":42}' WHERE id = 'part'`,
        );
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.getPart(tx, {
                sessionID: info.sessionID,
                messageID: info.id,
                partID: "part",
              }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.list(tx, { sessionID: info.sessionID, limit: 10 }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
      }),
    );
  });
});

describe("MessageStore.list around", () => {
  test("centers a page on one Message, fills from the older side, and continues older", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        for (const id of ["a", "b", "c", "d", "e"]) {
          yield* db.transaction((tx) =>
            store.insert(tx, {
              info: user(id),
              parts: id === "d" ? [text("d-part", "d")] : [],
            }),
          );
        }
        yield* db.update(agentMessages).set({ createdAt: 100 });
        const page = (input: Omit<MessageStore.ListInput, "sessionID">) =>
          db.transaction((tx) =>
            store.list(tx, { sessionID: "ses_1", ...input }),
          );
        const ids = (result: MessageStore.Page) =>
          result.items.map((item) => item.info.id);

        const centered = yield* page({ around: "c", limit: 3 });
        expect(ids(centered)).toEqual(["b", "c", "d"]);
        expect(centered.items[2]!.parts.map((part) => part.id)).toEqual([
          "d-part",
        ]);
        expect(centered.nextCursor).not.toBeNull();
        expect(
          ids(yield* page({ cursor: centered.nextCursor!, limit: 3 })),
        ).toEqual(["a"]);

        expect(ids(yield* page({ around: "e", limit: 3 }))).toEqual([
          "c",
          "d",
          "e",
        ]);
        const start = yield* page({ around: "a", limit: 3 });
        expect(ids(start)).toEqual(["a", "b"]);
        expect(start.nextCursor).toBeNull();
        expect(ids(yield* page({ around: "c", limit: 1 }))).toEqual(["c"]);
        expect(ids(yield* page({ around: "c", limit: 10 }))).toEqual([
          "a",
          "b",
          "c",
          "d",
          "e",
        ]);

        expect(
          yield* Effect.flip(page({ around: "missing", limit: 3 })),
        ).toMatchObject({
          _tag: "AgentStore.NotFound",
          entity: "message",
          id: "missing",
        });
        expect(
          yield* Effect.flip(
            page({ around: "e", limit: 3, throughCreatedAt: 50 }),
          ),
        ).toMatchObject({
          _tag: "AgentStore.NotFound",
          entity: "message",
          id: "e",
        });
      }),
    );
  });
});
