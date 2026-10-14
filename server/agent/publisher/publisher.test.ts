// Purpose: Verifies protocol-free committed changes and publication ordering.

import { SessionId } from "@openchart/server/agent/contracts/session";
import { Session } from "@openchart/server/agent/session";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { assertExists } from "@openchart/utils/assert";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { expect, test } from "vitest";
import { Publisher } from "./publisher";

const dependencies = Layer.mergeAll(
  Database.layer(":memory:", () => Effect.void),
  Events.layer,
  Session.layer,
);

test("domain operations deliver committed facts to a protocol-free implementation", async () => {
  const changes: Publisher.Change[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service;
      const database = yield* Database.Service;
      const publisher: Publisher.Interface = {
        publish: (change) =>
          Effect.gen(function* () {
            if (change.type === "session.updated") {
              const saved = yield* session
                .get(change.session.id)
                .pipe(Effect.orDie);
              expect(saved).toEqual(change.session);
            }
            if (change.type === "part.updated") {
              const saved = yield* session
                .getPart({
                  sessionID: change.info.sessionID,
                  messageID: change.info.id,
                  partID: change.part.id,
                })
                .pipe(Effect.orDie);
              expect(saved).toEqual(change.part);
            }
            changes.push(change);
          }).pipe(Effect.provideService(Database.Service, database)),
      };
      yield* Effect.gen(function* () {
        const root = yield* session.create();
        const message = yield* session.createMessage({
          info: {
            id: "user",
            sessionID: root.id,
            role: "user",
            agent: "analyst",
            model: { providerID: "test", modelID: "test" },
            time: { created: 1 },
          },
          parts: [],
        });
        const first = yield* session.createPart({
          id: "text",
          messageID: message.info.id,
          type: "text",
          text: "before",
        });
        yield* session.updatePart({ ...first, text: "after" });
        const failed = yield* Effect.exit(session.createMessage(message));
        expect(Exit.isFailure(failed)).toBe(true);
        expect(changes.map((change) => change.type)).toEqual([
          "session.updated",
          "message.created",
          "session.updated",
          "part.updated",
          "part.updated",
        ]);
        expect(changes[0]).toMatchObject({ session: { title: "New session" } });
        expect(changes[4]).toMatchObject({
          previous: { text: "before" },
          part: { text: "after" },
        });
        expect(
          yield* session.getPart({
            sessionID: root.id,
            messageID: message.info.id,
            partID: first.id,
          }),
        ).toMatchObject({ text: "after" });
      }).pipe(Effect.provideService(Publisher.Service, publisher));
    }).pipe(Effect.provide(dependencies)),
  );
});

test("awaits delivery before a later write or observer snapshot can enter the barrier", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.Service;
        const events = yield* Events.Service;
        const publishing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const attempted = yield* Deferred.make<void>();
        const snapshots: string[] = [];
        const delivered: string[] = [];
        const publisher: Publisher.Interface = {
          publish: (change) =>
            Effect.gen(function* () {
              if (change.type !== "session.updated") return;
              if (change.session.title === "first") {
                yield* Deferred.succeed(publishing, undefined);
                yield* Deferred.await(release);
              }
              delivered.push(change.session.title);
            }),
        };
        yield* Effect.gen(function* () {
          const id = SessionId.make("ses_ordering");
          const writer = yield* session
            .create({ id, title: "first" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(publishing);
          const later = yield* Effect.gen(function* () {
            yield* Deferred.succeed(attempted, undefined);
            return yield* session.update(id, { title: "second" });
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(attempted);
          const observer = yield* events
            .withBarrier(
              session.get(id).pipe(
                Effect.tap((value) =>
                  Effect.sync(() => {
                    assertExists(
                      value,
                      "The first Session write has committed",
                    );
                    snapshots.push(value.title);
                  }),
                ),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          expect(delivered).toEqual([]);
          expect(snapshots).toEqual([]);
          // The first write is durable while both the later write and observer wait.
          expect((yield* session.get(id))?.title).toBe("first");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(writer);
          yield* Fiber.join(later);
          yield* Fiber.join(observer);
          expect(delivered).toEqual(["first", "second"]);
          expect(snapshots).toHaveLength(1);
        }).pipe(Effect.provideService(Publisher.Service, publisher));
      }),
    ).pipe(Effect.provide(dependencies)),
  );
});
