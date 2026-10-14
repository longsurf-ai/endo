// Purpose: Verifies the scheduler fiber outlives calls and finishes cleanup before dependencies close.

import { AgentRunStore } from "@openchart/server/agent/run/store";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { Session } from "@openchart/server/agent/session";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { Database } from "@openchart/server/db";
import { Events } from "@openchart/server/events";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { expect, test } from "vitest";

import { layer } from "./background";
import { Scheduler } from "./scheduler";

test("starts once and awaits run cleanup before releasing its service", async () => {
  const started = Deferred.makeUnsafe<void>();
  const stopping = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const order: string[] = [];
  let runs = 0;
  const scheduler = Layer.effect(
    Scheduler.Service,
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => order.push("service closed")),
      );
      return Scheduler.Service.of({
        runNow: () =>
          Effect.die("The background layer must not run manual fires"),
        runLoop: () =>
          Effect.gen(function* () {
            runs += 1;
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                order.push("run stopping");
                yield* Deferred.succeed(stopping, undefined);
                yield* Deferred.await(release);
                order.push("run closed");
              }),
            ),
          ),
      });
    }),
  );
  const runtime = ManagedRuntime.make(
    layer.pipe(
      Layer.provideMerge(scheduler),
      // The fake loop uses none of these; unexpected calls fail explicitly.
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(AgentRunStore.Service, {}),
          Layer.mock(Publisher.Service, {}),
          Layer.mock(Session.Service, {}),
          Layer.mock(SessionExecution.Service, {}),
          Layer.succeed(Database.Service, {
            get db(): never {
              throw new Error(
                "The fake scheduler must not access the database",
              );
            },
          }),
          Layer.mock(Events.Service, {}),
        ),
      ),
    ),
  );
  try {
    await runtime.context();
    await Effect.runPromise(Deferred.await(started));
    await runtime.context();
    await runtime.runPromise(Effect.void);
    expect(runs).toBe(1);
    expect(order).toEqual([]);

    const closing = runtime.dispose();
    await Effect.runPromise(Deferred.await(stopping));
    expect(order).toEqual(["run stopping"]);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await closing;
    expect(order).toEqual(["run stopping", "run closed", "service closed"]);
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await runtime.dispose();
  }
});
