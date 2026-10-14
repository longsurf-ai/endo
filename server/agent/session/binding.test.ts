// Purpose: Verifies binding identity, current-session reuse, and publication through Session.Service.

import { SessionId } from "@openchart/server/agent/contracts/session";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import {
  agentRun,
  agentSessionBindings,
  agentSessions,
} from "@openchart/server/agent/schema";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Effect, Exit, Layer } from "effect";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { Session } from "./session";

test("binding existing workflow children preserves creation order and creates no extra execution", () => {
  const publish = vi.fn<Publisher.Interface["publish"]>(() => Effect.void);
  const layer = Layer.mergeAll(
    Session.layer,
    Database.layer(":memory:", () => Effect.void),
    Events.layer,
    Layer.succeed(Publisher.Service, { publish }),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const { db } = yield* Database.Service;
      const parent = yield* sessions.create({ title: "Root" });
      const old = yield* sessions.create({
        kind: "delegate",
        parentId: parent.id,
      });
      const latest = yield* sessions.create({
        kind: "delegate",
        parentId: parent.id,
      });
      yield* db
        .update(agentSessions)
        .set({ createdAt: old.createdAt + 1 })
        .where(eq(agentSessions.id, latest.id));
      yield* sessions.bindExisting({ sessionId: latest.id, key: "cell" });
      yield* sessions.bindExisting({ sessionId: old.id, key: "cell" });
      yield* sessions.bindExisting({ sessionId: old.id, key: "cell" });
      expect((yield* sessions.getSessionByBinding({ key: "cell" }))?.id).toBe(
        latest.id,
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            sessions.bindExisting({ sessionId: old.id, key: "other-cell" }),
          ),
        ),
      ).toBe(true);
      expect(yield* db.select().from(agentSessionBindings)).toHaveLength(1);
      expect(yield* db.select().from(agentSessions)).toHaveLength(3);
      expect(yield* db.select().from(agentRun)).toHaveLength(0);
      expect(publish).toHaveBeenCalledWith({
        type: "session.updated",
        session: expect.objectContaining({
          id: latest.id,
          bindingId: expect.any(String),
        }),
      });
    }).pipe(Effect.provide(layer)),
  );
});

test("concurrent binding resolution creates one Session, preserves titles, and chooses the newest history", () => {
  const publish = vi.fn<Publisher.Interface["publish"]>(() => Effect.void);
  const layer = Layer.mergeAll(
    Session.layer,
    Database.layer(":memory:", () => Effect.void),
    Events.layer,
    Layer.succeed(Publisher.Service, { publish }),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const sessions = yield* Session.Service;
      const { db } = yield* Database.Service;
      expect(
        yield* sessions.getSessionByBinding({ key: "feature:slot" }),
      ).toBeNull();
      expect(yield* db.select().from(agentSessionBindings)).toHaveLength(0);
      expect(yield* db.select().from(agentSessions)).toHaveLength(0);
      expect(publish).not.toHaveBeenCalled();
      const [first, replay] = yield* Effect.all(
        [
          sessions.getOrCreateBound({
            kind: "chat",
            key: "feature:slot",
            title: "Original",
          }),
          sessions.getOrCreateBound({
            kind: "chat",
            key: "feature:slot",
            title: "Replacement",
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(replay).toEqual(first);
      expect(
        yield* sessions.getSessionByBinding({ key: "feature:slot" }),
      ).toEqual(first);
      expect(first.title).toBe("Original");
      expect(first.parentId).toBeNull();
      expect(first.kind).toBe("chat");
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        type: "session.updated",
        session: first,
      });
      expect(yield* db.select().from(agentSessionBindings)).toHaveLength(1);
      expect(yield* db.select().from(agentSessions)).toHaveLength(1);
      expect(yield* db.select().from(agentRun)).toHaveLength(0);
      const currentId = SessionId.create();
      yield* db.insert(agentSessions).values({
        kind: "chat",
        id: currentId,
        bindingId: first.bindingId,
        title: "New current",
        createdAt: first.createdAt + 1,
      });
      yield* db
        .update(agentSessions)
        .set({ updatedAt: first.createdAt + 10_000 })
        .where(eq(agentSessions.id, first.id));
      const current = yield* sessions.getOrCreateBound({
        kind: "chat",
        key: "feature:slot",
      });
      expect(current.id).toBe(currentId);
      expect(
        (yield* sessions.getSessionByBinding({ key: "feature:slot" }))?.id,
      ).toBe(currentId);
      expect(publish).toHaveBeenCalledTimes(1);
      const other = yield* sessions.getOrCreateBound({
        kind: "chat",
        key: "other:slot",
      });
      expect(other.id).not.toBe(currentId);
      expect(other.bindingId).not.toBe(first.bindingId);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            sessions.getOrCreateBound({ kind: "chat", key: " " }),
          ),
        ),
      ).toBe(true);
      expect(yield* db.select().from(agentSessionBindings)).toHaveLength(2);
      expect(publish).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
  );
});
