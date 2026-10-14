// Purpose: Locks Session operation defaults, metadata ownership, and post-commit events.

import { create } from "./create";
import { get } from "./get";
import { list } from "./list";
import { update } from "./update";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import * as Agui from "@openchart/server/agent/publisher/agui/adapter";
import { SessionId } from "@openchart/server/agent/contracts/session";
import { Session as SessionService } from "@openchart/server/agent/session";
import { commit } from "@openchart/server/agent/session/commit";
import { Database } from "@openchart/server/db";
import { EventDefinition, Events } from "@openchart/server/events";
import { AgentEvent } from "@openchart/server/agent/publisher/agui/events";
import { EventType } from "@ag-ui/core";
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { describe, expect, test } from "vitest";

import { sessionStore } from "@openchart/server/agent/session/store";

function run<A, E>(
  program: (
    published: EventDefinition.Payload[],
  ) => Effect.Effect<
    A,
    E,
    | SessionService.Service
    | Database.Service
    | Events.Service
    | Publisher.Service
  >,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* Events.Service;
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

describe("Session operations", () => {
  test("creates root defaults, publishes saved snapshots, and preserves read pagination", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const first = yield* create();
        const original = structuredClone(first);
        expect(first).toMatchObject({
          title: "New session",
          parentId: null,
          kind: "chat",
          bindingId: null,
          anchors: null,
          compactingAt: null,
          archivedAt: null,
        });
        expect(first.id).toMatch(/^ses_[0-9A-Za-z]{14}$/);
        expect(first.createdAt).toBeGreaterThan(0);
        expect(Schema.decodeUnknownSync(AgentEvent)(published[0]).data).toEqual(
          {
            sessionID: first.id,
            event: {
              type: EventType.STATE_DELTA,
              delta: [{ op: "add", path: "/session", value: first }],
            },
          },
        );
        first.title = "mutated caller result";
        expect(published[0]?.data).toEqual({
          sessionID: original.id,
          event: {
            type: EventType.STATE_DELTA,
            delta: [{ op: "add", path: "/session", value: original }],
          },
        });
        expect(yield* get(first.id)).toEqual(original);
        expect(yield* get(SessionId.make("ses_missing"))).toBeUndefined();

        const second = yield* create({
          id: SessionId.make("ses_explicit"),
          title: "Analysis",
        });
        const page = yield* list({ parentId: null, limit: 1 });
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).not.toBeNull();
        const next = yield* list({
          parentId: null,
          limit: 1,
          cursor: page.nextCursor!,
        });
        expect(
          new Set([...page.items, ...next.items].map((item) => item.id)),
        ).toEqual(new Set([first.id, second.id]));
        expect(next.nextCursor).toBeNull();
        expect(published.map((event) => event.type)).toEqual([
          "agent.event",
          "agent.event",
        ]);
      }),
    );
  });

  test("persists delegate relationships and publishes their committed snapshot", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const parent = yield* create();
        published.length = 0;
        const child = yield* create({
          title: "Research (@analyst subagent)",
          parentId: parent.id,
          kind: "delegate",
        });
        expect(child).toMatchObject({
          title: "Research (@analyst subagent)",
          parentId: parent.id,
          kind: "delegate",
          bindingId: null,
          anchors: null,
        });
        expect(yield* get(child.id)).toEqual(child);
        expect(yield* list({ parentId: parent.id, limit: 10 })).toEqual({
          items: [{ ...child, isActive: false, isUnread: false }],
          nextCursor: null,
        });
        expect(yield* list({ parentId: null, limit: 10 })).toEqual({
          items: [{ ...parent, isActive: false, isUnread: false }],
          nextCursor: null,
        });
        expect(published).toHaveLength(1);
        expect(Schema.decodeUnknownSync(AgentEvent)(published[0]).data).toEqual(
          {
            sessionID: child.id,
            event: {
              type: EventType.STATE_DELTA,
              delta: [{ op: "add", path: "/session", value: child }],
            },
          },
        );
      }),
    );
  });

  test("updates only metadata, preserves omissions, and clears explicit nulls", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const initial = yield* create({
          id: SessionId.make("ses_session"),
        });
        published.length = 0;
        const changes = {
          title: "Renamed",
          archivedAt: 123,
          id: "replacement",
          parentId: "parent",
          kind: "dig_in",
          bindingId: "binding",
          anchors: [],
          createdAt: 1,
          updatedAt: 2,
        };
        const updated = yield* update(initial.id, changes);
        expect(updated).toMatchObject({
          ...initial,
          title: "Renamed",
          archivedAt: 123,
          updatedAt: updated.updatedAt,
        });
        const cleared = yield* update(initial.id, {
          archivedAt: null,
        });
        expect(cleared).toMatchObject({
          title: "Renamed",
          archivedAt: null,
        });
        expect(published.map((event) => event.type)).toEqual([
          "agent.event",
          "agent.event",
        ]);
        expect(
          Schema.decodeUnknownSync(AgentEvent)(published[1]).data.event,
        ).toEqual({
          type: EventType.STATE_DELTA,
          delta: [{ op: "add", path: "/session", value: cleared }],
        });
      }),
    );
  });

  test("rejects failed writes without publishing or changing saved state", async () => {
    await run((published) =>
      Effect.gen(function* () {
        const original = yield* create({
          id: SessionId.make("ses_session"),
        });
        published.length = 0;
        const duplicate = yield* Effect.exit(
          create({ id: SessionId.make("ses_session") }),
        );
        const missing = yield* Effect.exit(
          update(SessionId.make("ses_missing"), { title: "No row" }),
        );
        const invalid = yield* Effect.exit(
          update(SessionId.make("ses_session"), {
            compactingAt: -1,
          }),
        );
        const invalidId = yield* Effect.exit(
          create({ id: "dsh_wrong-domain" as never }),
        );
        expect(
          [duplicate, missing, invalid, invalidId].every(Exit.isFailure),
        ).toBe(true);
        const { db } = yield* Database.Service;
        expect(
          yield* db.transaction((tx) =>
            sessionStore.get(tx, "dsh_wrong-domain"),
          ),
        ).toBeUndefined();
        expect(yield* get(SessionId.make("ses_session"))).toEqual(original);
        expect(published).toEqual([]);
      }),
    );
  });

  test("metadata reads need only Database and do not require Events", async () => {
    const page = await Effect.runPromise(
      list({ limit: 10 }).pipe(
        Effect.provide(Database.layer(":memory:", () => Effect.void)),
      ),
    );
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  test("interrupting a write rolls back before any change is published", async () => {
    await run((published) =>
      Effect.scoped(
        Effect.gen(function* () {
          const publisher = yield* Publisher.Service;
          const started = yield* Deferred.make<void>();
          const writer = yield* commit(
            (tx) =>
              Effect.gen(function* () {
                const info = yield* sessionStore.insert(tx, {
                  id: SessionId.make("ses_interrupted"),
                  title: "Pending",
                  parentId: null,
                  kind: "chat",
                  bindingId: null,
                  anchors: null,
                  compactingAt: null,
                  archivedAt: null,
                });
                yield* Deferred.succeed(started, undefined);
                yield* Effect.never;
                return info;
              }),
            (session) =>
              publisher.publish({ type: "session.updated", session }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(writer);
          expect(yield* get(SessionId.make("ses_interrupted"))).toBeUndefined();
          expect(published).toEqual([]);
        }),
      ),
    );
  });

  test("interruption after commit waits for publication to complete", async () => {
    await run((published) =>
      Effect.scoped(
        Effect.gen(function* () {
          const publishing = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const events = yield* Events.Service;
          const delayed: Events.Interface = {
            ...events,
            publish: (definition, data, options) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(publishing, undefined);
                yield* Deferred.await(release);
                return yield* events.publish(definition, data, options);
              }),
          };
          const writer = yield* create({
            id: SessionId.make("ses_committed"),
          }).pipe(
            Effect.provide(Layer.fresh(Agui.layer)),
            Effect.provideService(Events.Service, delayed),
            Effect.forkScoped,
          );
          yield* Deferred.await(publishing);
          const interruption = yield* Fiber.interrupt(writer).pipe(
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interruption);
          expect((yield* get(SessionId.make("ses_committed")))?.id).toBe(
            "ses_committed",
          );
          expect(published.map((event) => event.type)).toEqual(["agent.event"]);
        }),
      ),
    );
  });
});
