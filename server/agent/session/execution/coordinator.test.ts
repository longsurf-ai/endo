// Purpose: Locks the production keyed wake, interruption, and cleanup behavior.

import { Context, Deferred, Effect, Fiber, Scope } from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";

import { SessionRunCoordinator } from "./coordinator";

function run<A, E>(effect: Effect.Effect<A, E, Scope.Scope>) {
  return Effect.runPromise(Effect.scoped(effect));
}

describe("SessionRunCoordinator", () => {
  test("captures drain requirements at construction, independently of wake callers", async () => {
    class DrainContext extends Context.Service<
      DrainContext,
      { prefix: string }
    >()("DrainContext") {}

    await run(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<string>();
        const make = SessionRunCoordinator.make({
          drain: (key: string) =>
            Effect.gen(function* () {
              const { prefix } = yield* DrainContext;
              yield* Deferred.succeed(drained, `${prefix}:${key}`);
            }),
        });
        expectTypeOf<Effect.Services<typeof make>>().toEqualTypeOf<
          Scope.Scope | DrainContext
        >();
        const coordinator = yield* make.pipe(
          Effect.provideService(DrainContext, { prefix: "application" }),
        );

        yield* coordinator
          .wake("session")
          .pipe(Effect.provideService(DrainContext, { prefix: "request" }));
        expect(yield* Deferred.await(drained)).toBe("application:session");
      }),
    );
  });

  test("starts execution when woken while idle", async () => {
    await run(
      Effect.gen(function* () {
        const drained = yield* Deferred.make<void>();
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Deferred.succeed(drained, undefined),
        });

        yield* coordinator.wake("session");
        yield* Deferred.await(drained);
      }),
    );
  });

  test("snapshots only active executions", async () => {
    await run(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const firstGate = yield* Deferred.make<void>();
        const secondGate = yield* Deferred.make<void>();
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            Deferred.succeed(
              key === "first" ? firstStarted : secondStarted,
              undefined,
            ).pipe(
              Effect.andThen(
                Deferred.await(key === "first" ? firstGate : secondGate),
              ),
            ),
        });

        expect(Array.from(yield* coordinator.active)).toEqual([]);
        yield* coordinator.wake("first");
        yield* Deferred.await(firstStarted);
        expect(Array.from(yield* coordinator.active)).toEqual(["first"]);

        yield* coordinator.wake("second");
        yield* Deferred.await(secondStarted);
        expect(Array.from(yield* coordinator.active)).toEqual([
          "first",
          "second",
        ]);

        yield* Deferred.succeed(firstGate, undefined);
        yield* Effect.yieldNow;
        expect(Array.from(yield* coordinator.active)).toEqual(["second"]);
        yield* Deferred.succeed(secondGate, undefined);
        yield* Effect.yieldNow;
        expect(Array.from(yield* coordinator.active)).toEqual([]);
      }),
    );
  });

  test("cleans active executions after failure and defect", async () => {
    await run(
      Effect.gen(function* () {
        const failure = new Error("failed");
        const defect = new Error("defect");
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            key === "failure" ? Effect.fail(failure) : Effect.die(defect),
        });

        yield* coordinator.wake("failure");
        yield* Effect.yieldNow;
        expect(Array.from(yield* coordinator.active)).toEqual([]);

        yield* coordinator.wake("defect");
        yield* Effect.yieldNow;
        expect(Array.from(yield* coordinator.active)).toEqual([]);
      }),
    );
  });

  test("cleans active executions when its scope closes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const coordinator = yield* Effect.scoped(
          Effect.gen(function* () {
            const coordinator = yield* SessionRunCoordinator.make({
              drain: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                ),
            });
            yield* coordinator.wake("session");
            yield* Deferred.await(started);
            expect(Array.from(yield* coordinator.active)).toEqual(["session"]);
            return coordinator;
          }),
        );

        expect(Array.from(yield* coordinator.active)).toEqual([]);
      }),
    );
  });

  test("coalesces wakes received during active execution", async () => {
    await run(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const firstGate = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        let runs = 0;
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((current) =>
                current === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(firstGate)),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        });

        yield* coordinator.wake("session");
        yield* Deferred.await(firstStarted);
        yield* Effect.all(
          [
            coordinator.wake("session"),
            coordinator.wake("session"),
            coordinator.wake("session"),
          ],
          { concurrency: "unbounded" },
        );
        yield* Deferred.succeed(firstGate, undefined);
        yield* Deferred.await(secondStarted);

        expect(runs).toBe(2);
      }),
    );
  });

  test("runs again when woken during the follow-up", async () => {
    await run(
      Effect.gen(function* () {
        const firstGate = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const secondGate = yield* Deferred.make<void>();
        const thirdStarted = yield* Deferred.make<void>();
        let runs = 0;
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((current) =>
                current === 1
                  ? Deferred.await(firstGate)
                  : current === 2
                    ? Deferred.succeed(secondStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(secondGate)),
                      )
                    : Deferred.succeed(thirdStarted, undefined),
              ),
            ),
        });

        yield* coordinator.wake("session");
        yield* Effect.yieldNow;
        yield* coordinator.wake("session");
        yield* Deferred.succeed(firstGate, undefined);
        yield* Deferred.await(secondStarted);
        yield* coordinator.wake("session");
        yield* Deferred.succeed(secondGate, undefined);
        yield* Deferred.await(thirdStarted);

        expect(runs).toBe(3);
      }),
    );
  });

  test("does nothing when interrupted while idle", async () => {
    await run(
      Effect.gen(function* () {
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.void,
        });
        yield* coordinator.interrupt("session");
      }),
    );
  });

  test("interrupts active execution and clears its pending wake", async () => {
    await run(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        let runs = 0;
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(interrupted, undefined),
              ),
            ),
        });

        yield* coordinator.wake("session");
        yield* Deferred.await(started);
        yield* coordinator.wake("session");
        yield* coordinator.interrupt("session");
        yield* Deferred.await(interrupted);

        expect(Array.from(yield* coordinator.active)).toEqual([]);
        expect(runs).toBe(1);
      }),
    );
  });

  test("runs a wake registered during interruption cleanup", async () => {
    await run(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const cleanupStarted = yield* Deferred.make<void>();
        const cleanupGate = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        let runs = 0;
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((current) =>
                current === 1
                  ? Deferred.succeed(firstStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() =>
                        Deferred.succeed(cleanupStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(cleanupGate)),
                        ),
                      ),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        });

        yield* coordinator.wake("session");
        yield* Deferred.await(firstStarted);
        const interrupt = yield* coordinator
          .interrupt("session")
          .pipe(Effect.forkChild);
        yield* Deferred.await(cleanupStarted);
        yield* coordinator.wake("session");
        yield* Deferred.succeed(cleanupGate, undefined);
        yield* Fiber.join(interrupt);
        yield* Deferred.await(secondStarted);

        expect(runs).toBe(2);
      }),
    );
  });

  test("starts one follow-up when a wake races with failure", async () => {
    await run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const failure = new Error("failed");
        let runs = 0;
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++runs).pipe(
              Effect.flatMap((current) =>
                current === 1
                  ? Deferred.await(gate).pipe(
                      Effect.andThen(Effect.fail(failure)),
                    )
                  : Deferred.succeed(secondStarted, undefined),
              ),
            ),
        });

        yield* coordinator.wake("session");
        yield* Effect.yieldNow;
        yield* coordinator.wake("session");
        yield* Deferred.succeed(gate, undefined);

        yield* Deferred.await(secondStarted);
        expect(runs).toBe(2);
      }),
    );
  });

  test("runs different keys concurrently", async () => {
    await run(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const bothStarted = yield* Deferred.make<void>();
        let active = 0;
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () =>
            Effect.sync(() => ++active).pipe(
              Effect.tap(() =>
                active === 2
                  ? Deferred.succeed(bothStarted, undefined)
                  : Effect.void,
              ),
              Effect.andThen(Deferred.await(gate)),
            ),
        });

        yield* coordinator.wake("first");
        yield* coordinator.wake("second");
        yield* Deferred.await(bothStarted);
        yield* Deferred.succeed(gate, undefined);
      }),
    );
  });

  test("trampolines synchronous self-waking execution", async () => {
    await run(
      Effect.gen(function* () {
        const limit = 20_000;
        const completed = yield* Deferred.make<void>();
        let runs = 0;
        let wake: (key: string) => Effect.Effect<void> = () => Effect.void;
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (key: string) =>
            Effect.sync(() => ++runs).pipe(
              Effect.tap((current) =>
                current < limit
                  ? wake(key)
                  : Deferred.succeed(completed, undefined),
              ),
              Effect.asVoid,
            ),
        });
        wake = coordinator.wake;

        yield* coordinator.wake("session");
        yield* Deferred.await(completed);

        expect(runs).toBe(limit);
      }),
    );
  });
});
