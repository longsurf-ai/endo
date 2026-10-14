// Purpose: Verifies durable run outcomes, queue progress, and cancellation cleanup.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Prompt } from "@openchart/server/agent/prompt/prompt";
import { Failed } from "@openchart/server/agent/prompt/errors";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { SessionRunCoordinator } from "@openchart/server/agent/session/execution/coordinator";
import { agentSessions } from "@openchart/server/agent/schema";
import { makeRuntime } from "@openchart/server/runtime";
import { Database } from "@openchart/server/db";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import { describe, expect, test } from "vitest";

import { SessionRunner } from "./runner";

const prompt = Schema.decodeUnknownSync(AgentPromptInput)({
  agent: "analyst",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text", text: "Hello" }],
});

async function run<A, E>(
  effect: Effect.Effect<
    A,
    E,
    | AgentRunStore.Service
    | SessionRunner.Service
    | Effect.Services<ReturnType<SessionRunner.Interface["run"]>>
  >,
  execute: Prompt.Interface["execute"],
  override: (store: AgentRunStore.Interface) => AgentRunStore.Interface = (
    store,
  ) => store,
) {
  const store = Layer.effect(
    AgentRunStore.Service,
    Effect.map(AgentRunStore.Service, override),
  ).pipe(Layer.provide(AgentRunStore.layer));
  const layer = SessionRunner.layer.pipe(
    Layer.provide(Layer.succeed(Prompt.Service, { execute })),
    Layer.provideMerge(store),
    Layer.fresh,
  );
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
  });
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        yield* db
          .insert(agentSessions)
          .values({ kind: "chat", id: "session-1", title: "Test" });
        return yield* effect;
      }).pipe(Effect.provide(layer)),
    );
  } finally {
    await runtime.dispose();
  }
}

const setup = Effect.gen(function* () {
  const store = yield* AgentRunStore.Service;
  const runner = yield* SessionRunner.Service;
  const runs = yield* Effect.forEach(["first", "second"], (sessionIntentID) =>
    store.enqueue({ sessionID: "session-1", sessionIntentID, input: prompt }),
  );
  const rows = Effect.forEach(runs, (run) => store.get(run.id));
  return { runner, store, runs, rows };
});

describe("SessionRunner lifecycle", () => {
  test("completes successful work and drains the queue", async () => {
    await run(
      Effect.gen(function* () {
        const { runner, rows } = yield* setup;
        yield* runner.run({ sessionID: "session-1" });
        for (const row of yield* rows) {
          expect(row?.status).toBe("completed");
          expect(row?.finishedAt).toEqual(expect.any(Number));
        }
      }),
      () => Effect.void,
    );
  });

  test("fails expected errors and continues the queue", async () => {
    await run(
      Effect.gen(function* () {
        const { runner, rows } = yield* setup;
        yield* runner.run({ sessionID: "session-1" });
        expect((yield* rows).map((row) => row?.status)).toEqual([
          "failed",
          "completed",
        ]);
      }),
      (run) =>
        run.sessionIntentID === "first"
          ? Effect.fail(new Failed({ cause: new Error("model unavailable") }))
          : Effect.void,
    );
  });

  test.each(["effect", "throw", "mixed"] as const)(
    "fails defects and stops the queue (%s)",
    async (mode) => {
      const defect = new Error("broken prompt");
      await run(
        Effect.gen(function* () {
          const { runner, rows, store, runs } = yield* setup;
          const exit = yield* Effect.exit(
            runner.run({ sessionID: "session-1" }),
          );
          expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
          expect((yield* rows).map((row) => row?.status)).toEqual([
            "failed",
            "queued",
          ]);
          expect((yield* store.claim("session-1"))?.id).toBe(runs[1]?.id);
        }),
        () => {
          if (mode === "throw") throw defect;
          if (mode === "mixed") {
            return Effect.fail(
              new Failed({ cause: new Error("model failure") }),
            ).pipe(Effect.onExit(() => Effect.die(defect)));
          }
          return Effect.die(defect);
        },
      );
    },
  );

  test.each(["claim", "prompt", "completion"] as const)(
    "settles the active run without claiming the next when interrupted during %s",
    async (phase) => {
      const started = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      await run(
        Effect.gen(function* () {
          const { runner, rows, store, runs } = yield* setup;
          const fiber = yield* runner
            .run({ sessionID: "session-1" })
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const interruption = yield* Fiber.interrupt(fiber).pipe(
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interruption);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
            true,
          );
          const [first, second] = yield* rows;
          expect(first?.status).toBe(
            phase === "completion" ? "completed" : "stop",
          );
          expect(first?.finishedAt).toEqual(expect.any(Number));
          expect(second?.status).toBe("queued");
          expect((yield* store.claim("session-1"))?.id).toBe(runs[1]?.id);
        }),
        () =>
          phase === "completion"
            ? Effect.void
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
              ),
        (store) =>
          phase === "prompt"
            ? store
            : phase === "completion"
              ? {
                  ...store,
                  complete: (id) =>
                    store
                      .complete(id)
                      .pipe(
                        Effect.tap(() =>
                          Deferred.succeed(started, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                          ),
                        ),
                      ),
                }
              : {
                  ...store,
                  claim: (sessionID) =>
                    store
                      .claim(sessionID)
                      .pipe(
                        Effect.tap(() =>
                          Deferred.succeed(started, undefined).pipe(
                            Effect.andThen(Deferred.await(release)),
                          ),
                        ),
                      ),
                },
      );
    },
  );

  test.each(["success", "error", "defect"] as const)(
    "settles a user Stop after cleanup (%s) and preserves interruption",
    async (cleanup) => {
      const started = Deferred.makeUnsafe<void>();
      const cleaning = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      await run(
        Effect.gen(function* () {
          const { runner, rows } = yield* setup;
          const stopped =
            yield* Deferred.make<Exit.Exit<void, SessionRunner.RunError>>();
          const coordinator = yield* SessionRunCoordinator.make({
            drain: (sessionID: string) =>
              runner
                .run({ sessionID })
                .pipe(Effect.onExit((exit) => Deferred.succeed(stopped, exit))),
          });
          yield* coordinator.wake("session-1");
          yield* Deferred.await(started);
          const interruption = yield* coordinator
            .interrupt("session-1")
            .pipe(Effect.forkChild);
          yield* Deferred.await(cleaning);
          expect((yield* rows).map((row) => row?.status)).toEqual([
            "running",
            "queued",
          ]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interruption);
          const exit = yield* Deferred.await(stopped);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
            true,
          );
          const [first, second] = yield* rows;
          expect(first?.status).toBe(cleanup === "success" ? "stop" : "failed");
          expect(first?.finishedAt).toEqual(expect.any(Number));
          expect(second?.status).toBe("queued");
          expect(yield* coordinator.active).toEqual(new Set());
        }).pipe(Effect.scoped),
        () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onExit(() =>
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(
                  cleanup === "success"
                    ? Effect.void
                    : cleanup === "error"
                      ? Effect.fail(
                          new Failed({ cause: new Error("cleanup failed") }),
                        )
                      : Effect.die(new Error("cleanup defect")),
                ),
              ),
            ),
          ),
      );
    },
  );

  test.each(["complete", "fail"] as const)(
    "propagates a %s write failure and stops the queue",
    async (transition) => {
      const failure = new SqlError({
        reason: new UnknownError({ cause: new Error("write failed") }),
      });
      await run(
        Effect.gen(function* () {
          const { runner, rows } = yield* setup;
          const exit = yield* Effect.exit(
            runner.run({ sessionID: "session-1" }),
          );
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(
            failure,
          );
          expect((yield* rows).map((row) => row?.status)).toEqual([
            "running",
            "queued",
          ]);
        }),
        () =>
          transition === "complete"
            ? Effect.void
            : Effect.fail(
                new Failed({ cause: new Error("model unavailable") }),
              ),
        (store) => ({ ...store, [transition]: () => Effect.fail(failure) }),
      );
    },
  );
});
