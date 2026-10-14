// Purpose: Locks typed live event delivery, lifecycle, and bounded overflow behavior.

import { Effect, Exit, Fiber, Schema, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { EventDefinition, Events } from "./index";

const Renamed = EventDefinition.define({
  type: "test.renamed",
  schema: { id: Schema.String, name: Schema.String },
});

const Deleted = EventDefinition.define({
  type: "test.deleted",
  schema: { id: Schema.String },
});

function run<A, E>(effect: Effect.Effect<A, E, Events.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(Events.layer)));
}

describe("Events", () => {
  test("broadcasts to each observer before stream consumption starts", async () => {
    const program = Effect.gen(function* () {
      const events = yield* Events.Service;
      // Events before registration are not replayed.
      yield* events.publish(Deleted, { id: "old" });
      const first = yield* events.allBounded(2);
      const second = yield* events.allBounded(2);

      const event = yield* events.publish(
        Renamed,
        { id: "watchlist-1", name: "Core" },
        { metadata: { requestID: "request-1" } },
      );
      const deleted = yield* events.publish(Deleted, { id: "watchlist-1" });

      return {
        event,
        deleted,
        first: Array.from(yield* first.pipe(Stream.take(2), Stream.runCollect)),
        second: Array.from(
          yield* second.pipe(Stream.take(2), Stream.runCollect),
        ),
      };
    });

    const result = await run(Effect.scoped(program));
    expect(result.first).toEqual([result.event, result.deleted]);
    expect(result.second).toEqual(result.first);
    expect(result.event.id).toMatch(/^evt_[0-9A-Za-z]{14}$/);
    expect(result.event.type).toBe("test.renamed");
    expect(result.event.metadata).toEqual({ requestID: "request-1" });
  });

  test("isolates a failing subscriber from the publisher", async () => {
    const program = Effect.gen(function* () {
      const events = yield* Events.Service;
      const stream = yield* events.allBounded(1);
      const subscriber = yield* stream.pipe(
        Stream.runForEach(() => Effect.fail("subscriber failed")),
        Effect.forkScoped,
      );
      const event = yield* events.publish(Deleted, { id: "watchlist-1" });
      const subscriberExit = yield* Fiber.await(subscriber);
      return { event, subscriberExit };
    });

    const result = await run(Effect.scoped(program));
    expect(result.event.type).toBe("test.deleted");
    expect(Exit.isFailure(result.subscriberExit)).toBe(true);
  });

  test("validates payloads with the feature-owned definition", () => {
    const payload = {
      id: EventDefinition.ID.create(),
      type: "test.renamed",
      data: { id: "watchlist-1", name: "Core" },
    };

    expect(Schema.decodeUnknownSync(Renamed)(payload)).toEqual(payload);
    expect(() =>
      Schema.decodeUnknownSync(Renamed)({ ...payload, type: "test.deleted" }),
    ).toThrow();
  });

  test("fails a bounded subscriber instead of dropping an event", async () => {
    const program = Effect.gen(function* () {
      const events = yield* Events.Service;
      const stream = yield* events.allBounded(1);
      yield* events.publish(Deleted, { id: "watchlist-1" });
      yield* events.publish(Deleted, { id: "watchlist-2" });
      yield* Effect.yieldNow;
      return yield* Stream.runCollect(stream).pipe(Effect.exit);
    });

    const exit = await run(Effect.scoped(program));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("Events.SubscriberOverflow");
    }
  });

  test("captures an event published immediately after bounded subscription acquisition", async () => {
    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* Events.Service;
          const stream = yield* events.allBounded(1);
          // No scheduling yield or stream consumption between acquisition/publication.
          const event = yield* events.publish(Deleted, { id: "immediate" });
          expect(yield* Stream.runCollect(Stream.take(stream, 1))).toEqual([
            event,
          ]);
        }),
      ),
    );
  });
});
