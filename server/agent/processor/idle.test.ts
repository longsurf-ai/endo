// Purpose: Verifies idle deadlines, busy suppression, and scoped stream cleanup.

import { Cause, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, test } from "vitest";
import { StreamStalled } from "./errors";
import { withIdleTimeout } from "./idle";

describe("processor idle timeout", () => {
  test("fails an idle pull at its deadline and releases the source", async () => {
    let released = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = Stream.never.pipe(
          Stream.ensuring(Effect.sync(() => (released = true))),
        );
        const running = yield* Effect.forkChild(
          source.pipe(
            withIdleTimeout(() => false, 100),
            Stream.runDrain,
            Effect.flip,
          ),
        );
        yield* TestClock.adjust(99);
        expect(running.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        const failure = yield* Fiber.join(running);
        expect(failure).toBeInstanceOf(StreamStalled);
        expect(failure.stallMs).toBe(100);
        expect(released).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("each source event starts a new window", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* Queue.make<string>();
        const seen: string[] = [];
        const running = yield* Effect.forkChild(
          Stream.fromQueue(source).pipe(
            withIdleTimeout(() => false, 100),
            Stream.runForEach((value) => Effect.sync(() => seen.push(value))),
            Effect.flip,
          ),
        );
        yield* TestClock.adjust(90);
        yield* Queue.offer(source, "event");
        yield* TestClock.adjust(99);
        expect(seen).toEqual(["event"]);
        expect(running.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(running)).toBeInstanceOf(StreamStalled);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("does not time downstream transcript work", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const running = yield* Effect.forkChild(
          Stream.make("event").pipe(
            withIdleTimeout(() => false, 100),
            Stream.runForEach(() => Effect.sleep(1_000)),
          ),
        );
        yield* TestClock.adjust(1_000);
        yield* Fiber.join(running);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("tool events disarm and rearm the timer without a second state owner", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* Queue.make<"tool-call" | "tool-result">();
        let busy = false;
        const running = yield* Effect.forkChild(
          Stream.fromQueue(source).pipe(
            withIdleTimeout(() => busy, 100),
            Stream.runForEach((event) =>
              Effect.sync(() => (busy = event === "tool-call")),
            ),
            Effect.flip,
          ),
        );
        yield* Queue.offer(source, "tool-call");
        yield* TestClock.adjust(1_000);
        expect(running.pollUnsafe()).toBeUndefined();
        yield* Queue.offer(source, "tool-result");
        yield* TestClock.adjust(99);
        expect(running.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(running)).toBeInstanceOf(StreamStalled);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("permission signals suspend and fully reset a pending pull deadline", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const activity = yield* Queue.sliding<void>(1);
        let busy = false;
        let pulls = 0;
        const source = Stream.fromEffect(
          Effect.sync(() => pulls++).pipe(Effect.andThen(Effect.never)),
        );
        const running = yield* Effect.forkChild(
          source.pipe(
            withIdleTimeout(() => busy, 100, Queue.take(activity)),
            Stream.runDrain,
            Effect.flip,
          ),
        );
        yield* TestClock.adjust(90);
        busy = true;
        yield* Queue.offer(activity, undefined);
        yield* TestClock.adjust(1_000);
        expect(running.pollUnsafe()).toBeUndefined();
        busy = false;
        yield* Queue.offer(activity, undefined);
        yield* TestClock.adjust(99);
        expect(running.pollUnsafe()).toBeUndefined();
        expect(pulls).toBe(1);
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(running)).toBeInstanceOf(StreamStalled);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("interruption stays interruption and releases a busy source", async () => {
    let released = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = Stream.never.pipe(
          Stream.ensuring(Effect.sync(() => (released = true))),
        );
        const running = yield* Effect.forkChild(
          source.pipe(
            withIdleTimeout(() => true, 100),
            Stream.runDrain,
          ),
        );
        yield* TestClock.adjust(1_000);
        yield* Fiber.interrupt(running);
        const result = yield* Fiber.await(running);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(Cause.hasInterrupts(result.cause)).toBe(true);
        }
        expect(released).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });

  test("preserves source errors and defects", async () => {
    const failure = new Error("source failure");
    await expect(
      Effect.runPromise(
        Stream.fail(failure).pipe(
          withIdleTimeout(() => false, 100),
          Stream.runDrain,
          Effect.flip,
        ),
      ),
    ).resolves.toBe(failure);

    const defect = new Error("source defect");
    const result = await Effect.runPromiseExit(
      Stream.die(defect).pipe(
        withIdleTimeout(() => false, 100),
        Stream.runDrain,
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(true);
  });
});
