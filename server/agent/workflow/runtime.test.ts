// Purpose: Locks workflow concurrency, immutable snapshots, failure isolation, and cancellation.

import { Cause, Deferred, Exit, Fiber } from "effect";
import { expect, test } from "vitest";
import {
  agent,
  defineWorkflow,
  Effect,
  parallel,
  Schema,
  type AgentPromptInput,
} from "@openchart/server/agent/workflow/authoring";
import { Invocation, run } from "./runtime";
import { Workflow } from "./workflow";

const prompt: AgentPromptInput = {
  agent: "analyst",
  model: { providerID: "codex" as const, modelID: "tier1" as const },
  parts: [{ type: "text", text: "Question" }],
};
const definition = defineWorkflow({
  description: "Test",
  args: Schema.Struct({}),
  run: () => parallel(Array.from({ length: 5 }, () => agent(prompt))),
});

test("bounds every agent call, preserves ordering, and isolates expected child failure", async () => {
  let active = 0;
  let maximum = 0;
  let started = 0;
  const result = await Effect.runPromise(
    run(definition, {}).pipe(
      Effect.provideService(Workflow.Service, {
        getResource: () => Effect.die("Unexpected Resource read"),
        parentPrompt: prompt,
        settings: { concurrency: 2 },
        agent: () =>
          Effect.gen(function* () {
            const id = started++;
            active++;
            maximum = Math.max(maximum, active);
            return yield* Effect.gen(function* () {
              yield* Effect.sleep(`${5 - id} millis`);
              if (id === 1)
                return yield* Effect.fail(new Error("Research unavailable"));
              return { sessionId: `child-${id}`, output: String(id) };
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  active--;
                }),
              ),
            );
          }),
      }),
    ),
  );
  expect(maximum).toBe(2);
  expect(active).toBe(0);
  expect(result).toEqual([
    { status: "success", value: { sessionId: "child-0", output: "0" } },
    {
      status: "error",
      error: { name: "Error", message: "Research unavailable" },
    },
    ...[2, 3, 4].map((id) => ({
      status: "success",
      value: { sessionId: `child-${id}`, output: String(id) },
    })),
  ]);
});

test.each([1, 2, 5])(
  "run enforces a child limit of %i with direct Effect.all",
  async (concurrency) => {
    let active = 0;
    let maximum = 0;
    const direct = defineWorkflow({
      description: "Direct concurrency",
      args: Schema.Struct({}),
      run: () =>
        Effect.all(
          Array.from({ length: 5 }, () => agent(prompt)),
          { concurrency: "unbounded" },
        ),
    });
    await Effect.runPromise(
      run(direct, {}).pipe(
        Effect.provideService(Workflow.Service, {
          getResource: () => Effect.die("Unexpected Resource read"),
          parentPrompt: prompt,
          settings: { concurrency },
          agent: () =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active++;
                maximum = Math.max(maximum, active);
              }),
              () =>
                Effect.sleep("1 millis").pipe(
                  Effect.as({ sessionId: "child", output: "Answer" }),
                ),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            ),
        }),
      ),
    );
    expect(maximum).toBe(concurrency);
    expect(active).toBe(0);
  },
);

test.each(["parallel", "direct"] as const)(
  "cancellation joins %s children and never starts waiting children",
  async (mode) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const cleaning = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          let started = 0;
          let cleaned = 0;
          let settled = false;
          const cancellable = defineWorkflow({
            description: "Cancellation across both concurrency entrypoints",
            args: Schema.Struct({}),
            run: () => {
              const children = Array.from({ length: 5 }, () => agent(prompt));
              return mode === "parallel"
                ? parallel(children)
                : Effect.all(children, { concurrency: "unbounded" });
            },
          });
          const fiber = yield* Effect.forkChild(
            run(cancellable, {}).pipe(
              Effect.provideService(Workflow.Service, {
                getResource: () => Effect.die("Unexpected Resource read"),
                parentPrompt: prompt,
                settings: { concurrency: 2 },
                agent: () =>
                  Effect.gen(function* () {
                    started++;
                    if (started === 2)
                      yield* Deferred.succeed(ready, undefined);
                    return yield* Effect.never.pipe(
                      Effect.ensuring(
                        Effect.gen(function* () {
                          yield* Deferred.succeed(cleaning, undefined);
                          yield* Deferred.await(release);
                          cleaned++;
                        }),
                      ),
                    );
                  }),
              }),
            ),
          );
          yield* Deferred.await(ready);
          const stopping = yield* Fiber.interrupt(fiber).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                settled = true;
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(cleaning);
          expect(settled).toBe(false);
          expect(cleaned).toBe(0);
          expect(started).toBe(2);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(stopping);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
            true,
          );
          expect(started).toBe(2);
          expect(cleaned).toBe(2);
        }),
      ),
    );
  },
);

test("cancellation during argument preparation never enters the workflow", async () => {
  let started = false;
  let cleaned = false;
  const prepared = Deferred.makeUnsafe<void>();
  const definition = defineWorkflow({
    description: "Preparation barrier",
    args: Schema.Struct({}),
    run: () =>
      Effect.sync(() => {
        started = true;
        return null;
      }),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* run(definition, {}, () =>
          Deferred.succeed(prepared, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                cleaned = true;
              }),
            ),
          ),
        ).pipe(
          Effect.provideService(Workflow.Service, {
            getResource: () => Effect.die("Unexpected Resource read"),
            parentPrompt: prompt,
            settings: { concurrency: 2 },
            agent: () => Effect.die("Must not start"),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(prepared);
        yield* Fiber.interrupt(fiber);
        expect(started).toBe(false);
        expect(cleaned).toBe(true);
      }),
    ),
  );
});

test("concurrent workflows sharing a host each own their concurrency allowance", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      const results = yield* Effect.all(
        [run(definition, {}), run(definition, {})],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.provideService(Workflow.Service, {
          getResource: () => Effect.die("Unexpected Resource read"),
          parentPrompt: prompt,
          settings: { concurrency: 2 },
          agent: () =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active++;
                maximum = Math.max(maximum, active);
              }),
              () =>
                Effect.gen(function* () {
                  if (active === 4) yield* Deferred.succeed(ready, undefined);
                  yield* Deferred.await(ready);
                  return { sessionId: "child", output: "Answer" };
                }),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            ),
        }),
      );
      expect(results).toEqual(
        Array.from({ length: 2 }, () =>
          Array.from({ length: 5 }, () => ({
            status: "success",
            value: { sessionId: "child", output: "Answer" },
          })),
        ),
      );
      expect(maximum).toBe(4);
      expect(active).toBe(0);
    }),
  );
});

test("defects propagate instead of becoming successful parallel outcomes", async () => {
  const exit = await Effect.runPromise(
    run(definition, {}).pipe(
      Effect.provideService(Workflow.Service, {
        getResource: () => Effect.die("Unexpected Resource read"),
        parentPrompt: prompt,
        settings: { concurrency: 5 },
        agent: () => Effect.die(new Error("Invariant violated")),
      }),
      Effect.exit,
    ),
  );
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
});

test("persists decoded arguments before execution and freezes detached inputs", async () => {
  const order: string[] = [];
  const source = { question: "  Research  " };
  const immutable = defineWorkflow({
    description: "Test",
    args: Schema.Struct({ question: Schema.Trim }),
    run: (args, context) =>
      Effect.sync(() => {
        order.push("run");
        expect(args.question).toBe("Research");
        expect(Object.isFrozen(args)).toBe(true);
        expect(Object.isFrozen(context.parentPrompt.parts)).toBe(true);
        expect(context.parentPrompt).not.toBe(prompt);
        return args;
      }),
  });
  const result = await Effect.runPromise(
    run(immutable, source, (args) =>
      Effect.sync(() => {
        order.push("prepared");
        expect(args).toEqual({ question: "Research" });
      }),
    ).pipe(
      Effect.provideService(Workflow.Service, {
        getResource: () => Effect.die("Unexpected Resource read"),
        parentPrompt: prompt,
        settings: { concurrency: 5 },
        agent: () => Effect.die("Unexpected agent"),
      }),
    ),
  );
  expect(order).toEqual(["prepared", "run"]);
  expect(result).toEqual({ question: "Research" });
  expect(source.question).toBe("  Research  ");
  expect(Object.isFrozen(source)).toBe(false);
});

test("rejects reserved context and invalid concurrency", async () => {
  expect(() =>
    Schema.decodeUnknownSync(Invocation)({
      workflow: "workspace:test.workflow.ts",
      args: { context: {} },
    }),
  ).toThrow();
  for (const concurrency of [0, -1, 1.5]) {
    const exit = await Effect.runPromise(
      run(definition, {}).pipe(
        Effect.provideService(Workflow.Service, {
          getResource: () => Effect.die("Unexpected Resource read"),
          parentPrompt: prompt,
          settings: { concurrency },
          agent: () => Effect.die("Must not start"),
        }),
        Effect.exit,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }
});
