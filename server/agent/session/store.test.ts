// Purpose: Locks Session SQL persistence, immutable columns, cursor scope, and transaction rollback.

import { SessionId } from "@openchart/server/agent/contracts/session";
import {
  agentRun,
  agentSessionBindings,
  agentSessions,
} from "@openchart/server/agent/schema";
import { Database } from "@openchart/server/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { describe, expect, test } from "vitest";
import { type SessionStore, sessionStore as store } from "./store";

function session(
  id: string,
  fields: Partial<SessionStore.InsertInput> = {},
): SessionStore.InsertInput {
  return {
    id: SessionId.make(id),
    parentId: null,
    kind: "chat",
    bindingId: null,
    anchors: null,
    title: id,
    compactingAt: null,
    archivedAt: null,
    ...fields,
  };
}

function run<A, E>(program: Effect.Effect<A, E, Database.Service>) {
  return Effect.runPromise(
    program.pipe(Effect.provide(Database.layer(":memory:", () => Effect.void))),
  );
}

describe("SessionStore", () => {
  test("round-trips facts, supplies SQL timestamps, and protects immutable columns", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const input = {
          ...session("ses_session", {
            kind: "dig_in",
            parentId: "parent",
          }),
          createdAt: 1,
          updatedAt: 2,
        };
        const created = yield* db.transaction((tx) => store.insert(tx, input));
        expect(created).toMatchObject(
          session("ses_session", {
            kind: "dig_in",
            parentId: "parent",
          }),
        );
        expect(created.createdAt).toBeGreaterThan(2);
        expect(created.updatedAt).toBe(created.createdAt);
        expect(
          yield* db.transaction((tx) => store.get(tx, "ses_session")),
        ).toEqual(created);

        yield* db
          .update(agentSessions)
          .set({ updatedAt: 1 })
          .where(eq(agentSessions.id, "ses_session"));
        const changes = {
          ...created,
          id: "ses_replacement",
          createdAt: 3,
          updatedAt: 4,
          title: "Edited",
        };
        const updated = yield* db.transaction((tx) =>
          store.update(tx, "ses_session", changes),
        );
        expect(updated).toEqual({
          ...created,
          title: "Edited",
          updatedAt: updated.updatedAt,
        });
        expect(updated.updatedAt).toBeGreaterThan(4);
        expect(
          yield* db.transaction((tx) => store.get(tx, "ses_replacement")),
        ).toBeUndefined();
      }),
    );
  });

  test("omitted fields stay unchanged and explicit null clears nullable facts", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db
          .insert(agentSessionBindings)
          .values({ id: "binding", key: "slot" });
        const anchors = [
          {
            partId: "part",
            text: "quote",
            startOffset: 0,
            endOffset: 5,
            childSessionId: "ses_child",
          },
        ];
        const created = yield* db.transaction((tx) =>
          store.insert(
            tx,
            session("ses_session", {
              bindingId: "binding",
              anchors,
              archivedAt: 10,
              compactingAt: 20,
            }),
          ),
        );
        const renamed = yield* db.transaction((tx) =>
          store.update(tx, created.id, { title: "Renamed" }),
        );
        expect(renamed).toMatchObject({
          bindingId: "binding",
          anchors,
          archivedAt: 10,
          compactingAt: 20,
        });
        const cleared = yield* db.transaction((tx) =>
          store.update(tx, created.id, {
            bindingId: null,
            anchors: null,
            archivedAt: null,
            compactingAt: null,
          }),
        );
        expect(cleared).toMatchObject({
          title: "Renamed",
          bindingId: null,
          anchors: null,
          archivedAt: null,
          compactingAt: null,
        });
        expect(cleared.createdAt).toBe(created.createdAt);
      }),
    );
  });

  test("distinguishes absent reads, missing updates, and duplicate inserts", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        expect(
          yield* db.transaction((tx) => store.get(tx, "ses_missing")),
        ).toBeUndefined();
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.update(tx, "ses_missing", { title: "No" }),
            ),
          ),
        ).toMatchObject({
          _tag: "AgentStore.NotFound",
          entity: "session",
          id: "ses_missing",
        });
        const original = yield* db.transaction((tx) =>
          store.insert(tx, session("ses_session")),
        );
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              db.transaction((tx) => store.insert(tx, session("ses_session"))),
            ),
          ),
        ).toBe(true);
        expect(
          yield* db.transaction((tx) => store.get(tx, "ses_session")),
        ).toEqual(original);
      }),
    );
  });

  test("uses creation time and ID across equal timestamps, new rows, and deleted cursor boundaries", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        for (const id of ["ses_a", "ses_b", "ses_c", "ses_d"]) {
          yield* db
            .insert(agentSessions)
            .values({ ...session(id), createdAt: 100, updatedAt: 100 });
        }
        yield* db
          .insert(agentSessions)
          .values({ ...session("ses_old"), createdAt: 50, updatedAt: 1000 });
        const first = yield* db.transaction((tx) =>
          store.list(tx, { limit: 2 }),
        );
        expect(first.items.map((item) => item.id)).toEqual(["ses_d", "ses_c"]);
        expect(first.nextCursor).toEqual(expect.any(String));
        yield* db.delete(agentSessions).where(eq(agentSessions.id, "ses_c"));
        yield* db
          .insert(agentSessions)
          .values({ ...session("ses_new"), createdAt: 200 });
        yield* db.transaction((tx) =>
          store.update(tx, "ses_a", { title: "Recently updated" }),
        );
        const second = yield* db.transaction((tx) =>
          store.list(tx, { limit: 2, cursor: first.nextCursor! }),
        );
        expect(second.items.map((item) => item.id)).toEqual(["ses_b", "ses_a"]);
        const third = yield* db.transaction((tx) =>
          store.list(tx, { limit: 2, cursor: second.nextCursor! }),
        );
        expect(third.items.map((item) => item.id)).toEqual(["ses_old"]);
        expect(third.nextCursor).toBeNull();
      }),
    );
  });

  test("paginates root chats and Chart Explain together without other kinds or child Sessions", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db.insert(agentSessions).values([
          {
            ...session("ses_scheduled", { kind: "scheduled" }),
            updatedAt: 100,
          },
          { ...session("ses_hidden", { kind: "scheduled" }), updatedAt: 90 },
          {
            ...session("ses_delegate", { kind: "delegate" }),
            updatedAt: 110,
          },
          {
            ...session("ses_dig_in", { kind: "dig_in", parentId: "ses_a" }),
            updatedAt: 80,
          },
          { ...session("ses_a"), createdAt: 30, updatedAt: 10 },
          { ...session("ses_b"), createdAt: 20, updatedAt: 40 },
          { ...session("ses_c"), createdAt: 10, updatedAt: 40 },
          {
            ...session("ses_child", { parentId: "ses_a" }),
            createdAt: 50,
            updatedAt: 50,
          },
        ]);
        const input = {
          kinds: ["chat", "delegate"],
          parentId: null,
          orderBy: "updatedAt",
          limit: 2,
        } as const;
        const first = yield* db.transaction((tx) => store.list(tx, input));
        expect(first.items.map((item) => item.id)).toEqual([
          "ses_delegate",
          "ses_c",
        ]);
        for (const kinds of [undefined, [], ["chat"], ["scheduled"]] as const) {
          expect(
            yield* Effect.flip(
              db.transaction((tx) =>
                store.list(tx, {
                  ...input,
                  kinds,
                  cursor: first.nextCursor!,
                }),
              ),
            ),
          ).toMatchObject({ _tag: "SchemaError" });
        }
        yield* db.delete(agentSessions).where(eq(agentSessions.id, "ses_c"));
        const second = yield* db.transaction((tx) =>
          store.list(tx, {
            ...input,
            kinds: ["delegate", "chat", "chat"],
            cursor: first.nextCursor!,
          }),
        );
        expect(second.items.map((item) => item.id)).toEqual(["ses_b", "ses_a"]);
        expect(second.nextCursor).toBeNull();
        expect(
          yield* db.transaction((tx) =>
            store.list(tx, { ...input, kinds: [] }),
          ),
        ).toEqual({ items: [], nextCursor: null });
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.list(tx, {
                ...input,
                orderBy: "createdAt",
                cursor: first.nextCursor!,
              }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        yield* db.transaction((tx) =>
          store.update(tx, "ses_a", { title: "Recently active" }),
        );
        expect(
          (yield* db.transaction((tx) => store.list(tx, input))).items[0]?.id,
        ).toBe("ses_a");
      }),
    );
  });

  test("filters archived Sessions before pagination and binds the filter to its cursor", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db.insert(agentSessions).values(
          ["ses_a", "ses_b", "ses_c", "ses_d"].map((id, index) => ({
            ...session(id, { archivedAt: index % 2 ? 100 : null }),
            createdAt: index + 1,
          })),
        );
        const first = yield* db.transaction((tx) =>
          store.list(tx, { limit: 1, excludeArchived: true }),
        );
        expect(first.items.map((item) => item.id)).toEqual(["ses_c"]);
        expect(first.nextCursor).not.toBeNull();
        const second = yield* db.transaction((tx) =>
          store.list(tx, {
            limit: 1,
            excludeArchived: true,
            cursor: first.nextCursor!,
          }),
        );
        expect(second.items.map((item) => item.id)).toEqual(["ses_a"]);
        expect(second.nextCursor).toBeNull();
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.list(tx, { limit: 1, cursor: first.nextCursor! }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        expect(
          (yield* db.transaction((tx) => store.list(tx, { limit: 10 }))).items,
        ).toHaveLength(4);
      }),
    );
  });

  test("lists activity from queued and running Runs without duplicating Sessions", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const states = [
          "idle",
          "queued",
          "running",
          "completed",
          "stop",
          "failed",
        ] as const;
        for (const status of states) {
          const id = `ses_${status}`;
          yield* db.transaction((tx) => store.insert(tx, session(id)));
          if (status === "idle") continue;
          yield* db.insert(agentRun).values({
            id: `run_${status}`,
            sessionId: id,
            sessionIntentId: `intent_${status}`,
            input: {
              agent: "analyst",
              model: {
                providerID: "codex" as const,
                modelID: "tier1" as const,
              },
              parts: [{ type: "text", text: "Hello" }],
            },
            status,
            queuePosition: status === "queued" ? 0 : null,
            createdAt: 1,
            startedAt: status === "queued" ? null : 2,
            finishedAt: status === "queued" || status === "running" ? null : 3,
          });
        }
        const initial = yield* db.transaction((tx) =>
          store.list(tx, { limit: 10 }),
        );
        expect(
          initial.items
            .filter((item) => item.isActive)
            .map((item) => item.id)
            .sort(),
        ).toEqual(["ses_queued", "ses_running"]);
        // Terminal history must not hide queued work or duplicate its Session.
        yield* db
          .update(agentRun)
          .set({ sessionId: "ses_queued" })
          .where(eq(agentRun.id, "run_completed"));
        const page = yield* db.transaction((tx) =>
          store.list(tx, { limit: 10 }),
        );
        expect(page.items).toHaveLength(states.length);
        expect(
          page.items
            .filter((item) => item.isActive)
            .map((item) => item.id)
            .sort(),
        ).toEqual(["ses_queued", "ses_running"]);
        expect(
          page.items.find((item) => item.id === "ses_idle")?.isActive,
        ).toBe(false);
      }),
    );
  });

  test("combines parent and binding filters while distinguishing null from no filter", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db
          .insert(agentSessionBindings)
          .values({ id: "binding", key: "slot" });
        for (const input of [
          session("ses_root"),
          session("ses_child", { parentId: "parent" }),
          session("ses_bound-root", { bindingId: "binding" }),
          session("ses_bound-child", {
            parentId: "parent",
            bindingId: "binding",
          }),
        ]) {
          yield* db.transaction((tx) => store.insert(tx, input));
        }
        const list = (fields: Omit<SessionStore.ListInput, "limit">) =>
          db.transaction((tx) => store.list(tx, { ...fields, limit: 10 }));
        expect((yield* list({})).items).toHaveLength(4);
        expect(
          (yield* list({ parentId: null })).items.map((item) => item.id).sort(),
        ).toEqual(["ses_bound-root", "ses_root"]);
        expect(
          (yield* list({ bindingId: null })).items
            .map((item) => item.id)
            .sort(),
        ).toEqual(["ses_child", "ses_root"]);
        expect(
          (yield* list({ parentId: "parent", bindingId: "binding" })).items.map(
            (item) => item.id,
          ),
        ).toEqual(["ses_bound-child"]);
        expect(yield* list({ parentId: "ses_missing" })).toEqual({
          items: [],
          nextCursor: null,
        });
      }),
    );
  });

  test("rejects invalid limits, malformed cursors, and changed cursor filters", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        for (const id of ["ses_a", "ses_b"])
          yield* db.transaction((tx) => store.insert(tx, session(id)));
        for (const limit of [
          0,
          -1,
          1.5,
          NaN,
          Infinity,
          Number.MAX_SAFE_INTEGER,
        ]) {
          expect(
            yield* Effect.flip(
              db.transaction((tx) => store.list(tx, { limit })),
            ),
          ).toMatchObject({ _tag: "SchemaError" });
        }
        for (const cursor of ["", "not-a-cursor", "e30="]) {
          expect(
            yield* Effect.flip(
              db.transaction((tx) => store.list(tx, { limit: 1, cursor })),
            ),
          ).toMatchObject({ _tag: "SchemaError" });
        }
        const first = yield* db.transaction((tx) =>
          store.list(tx, { limit: 1, parentId: null, bindingId: null }),
        );
        for (const scope of [
          {},
          { parentId: null },
          { parentId: "different", bindingId: null },
        ]) {
          expect(
            yield* Effect.flip(
              db.transaction((tx) =>
                store.list(tx, {
                  limit: 1,
                  cursor: first.nextCursor!,
                  ...scope,
                }),
              ),
            ),
          ).toMatchObject({ _tag: "SchemaError" });
        }
        expect(
          (yield* db.transaction((tx) =>
            store.list(tx, {
              limit: 2,
              cursor: first.nextCursor!,
              parentId: null,
              bindingId: null,
            }),
          )).nextCursor,
        ).toBeNull();
      }),
    );
  });

  test("rejects corrupt stored facts and rolls back writes whose returned state fails parsing", async () => {
    await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const original = yield* db.transaction((tx) =>
          store.insert(tx, session("ses_session")),
        );
        const anchors = [
          {
            partId: "part",
            text: "quote",
            startOffset: 5,
            endOffset: 1,
            childSessionId: "ses_child",
          },
        ];
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.update(tx, "ses_session", { anchors }),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        expect(
          yield* db.transaction((tx) => store.get(tx, "ses_session")),
        ).toEqual(original);
        expect(
          yield* Effect.flip(
            db.transaction((tx) =>
              store.insert(tx, session("ses_invalid", { anchors })),
            ),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        expect(
          yield* db.transaction((tx) => store.get(tx, "ses_invalid")),
        ).toBeUndefined();
        yield* db
          .update(agentSessions)
          .set({ anchors })
          .where(eq(agentSessions.id, "ses_session"));
        expect(
          yield* Effect.flip(
            db.transaction((tx) => store.get(tx, "ses_session")),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
        expect(
          yield* Effect.flip(
            db.transaction((tx) => store.list(tx, { limit: 10 })),
          ),
        ).toMatchObject({ _tag: "SchemaError" });
      }),
    );
  });
});
