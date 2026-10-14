// Purpose: Verifies tool construction, canonical decoding, outcome preservation, and Effect failure semantics.

import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Result,
  Schema,
} from "effect";
import { describe, expect, expectTypeOf, test } from "vitest";
import { InvalidArgumentsError } from "./errors";
import { Tool } from "./tool";

const Parameters = Schema.Struct({ count: Schema.Finite }).annotate({
  parseOptions: { onExcessProperty: "error" },
});

function context(callID = "call"): Tool.Context {
  return {
    rootRunID: "agr_test",
    sessionID: "session",
    messageID: "message",
    callID,
    agent: "agent",
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  };
}

function output(count: number): Tool.ExecuteResult<{ count: number }> {
  return {
    title: "Count",
    metadata: { count },
    output: { type: "json", value: { count } },
  };
}

describe("Tool", () => {
  test("preserves execution and host callback requirements without binding setup", async () => {
    class Offset extends Context.Service<Offset, { value: number }>()(
      "Offset",
    ) {}
    class Progress extends Context.Service<
      Progress,
      { record: (value: number) => void }
    >()("Progress") {}
    const calls: number[] = [];
    const Counter = Tool.define(
      "counter",
      Effect.succeed({
        description: "Read the execution offset",
        parameters: Parameters,
        execute: (args: typeof Parameters.Type, ctx: Tool.Context) =>
          Effect.gen(function* () {
            const offset = yield* Offset;
            yield* ctx.metadata({ metadata: { count: args.count } });
            return output(args.count + offset.value);
          }),
      }),
    );
    expectTypeOf<Effect.Services<typeof Counter>>().toEqualTypeOf<never>();
    expectTypeOf<Effect.Success<typeof Counter>>().not.toExtend<Tool.Info>();
    const definition = await Effect.runPromise(
      Counter.pipe(Effect.flatMap(Tool.init)),
    );
    const result = definition.execute(
      { count: 2 },
      {
        ...context(),
        metadata: ({ metadata }) =>
          Progress.use((progress) =>
            Effect.sync(() => progress.record(Number(metadata?.count))),
          ),
      },
    );
    expectTypeOf<Effect.Services<typeof result>>().toEqualTypeOf<
      Offset | Progress
    >();
    expectTypeOf<typeof definition>().not.toExtend<Tool.Def>();
    const run = (value: number) =>
      Effect.runPromise(
        result.pipe(
          Effect.provideService(Offset, { value }),
          Effect.provideService(Progress, {
            record: (value) => {
              calls.push(value);
            },
          }),
        ),
      );
    expect(await run(10)).toEqual(output(12));
    expect(await run(20)).toEqual(output(22));
    expect(calls).toEqual([2, 2]);
  });

  test("captures setup dependencies lazily and initializes fresh definitions", async () => {
    class Offset extends Context.Service<Offset, { value: number }>()(
      "Offset",
    ) {}
    let constructed = 0;
    let initialized = 0;
    const calls: string[] = [];
    const Counter = Tool.define(
      "counter",
      Effect.gen(function* () {
        const offset = yield* Offset;
        constructed++;
        return () =>
          Effect.sync(() => {
            initialized++;
            return {
              description: "Count with offset",
              parameters: Parameters,
              execute: (
                args: typeof Parameters.Type,
                ctx: Tool.Context<{ count: number }>,
              ) =>
                Effect.sync(() => {
                  calls.push(ctx.callID);
                  return output(args.count + offset.value);
                }),
            };
          });
      }),
    );

    expect(Counter.id).toBe("counter");
    expectTypeOf(Counter.id).toEqualTypeOf<"counter">();
    expectTypeOf<Tool.InferParameters<typeof Counter>>().toEqualTypeOf<
      typeof Parameters.Type
    >();
    expectTypeOf<Tool.InferMetadata<typeof Counter>>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<Effect.Services<typeof Counter>>().toEqualTypeOf<Offset>();
    expect(constructed).toBe(0);

    const info = await Effect.runPromise(
      Counter.pipe(Effect.provideService(Offset, { value: 10 })),
    );
    expect(constructed).toBe(1);
    expect(initialized).toBe(0);
    const first = await Effect.runPromise(Tool.init(info));
    const second = await Effect.runPromise(Tool.init(info));
    expectTypeOf(first.execute).parameter(0).toEqualTypeOf<unknown>();
    expect(initialized).toBe(2);
    expect(first).not.toBe(second);
    expect(first.id).toBe("counter");
    expect(second.id).toBe("counter");
    expect(first.parameters).toBe(Parameters);
    expect(calls).toEqual([]);

    const effects = [first, second].map((definition, index) =>
      definition.execute({ count: 2 }, context(`call-${index}`)),
    );
    expect(calls).toEqual([]);
    expect(await Effect.runPromise(Effect.all(effects))).toEqual([
      output(12),
      output(12),
    ]);
    expect(calls).toEqual(["call-0", "call-1"]);
  });

  test("decodes transformed arguments once and rejects malformed input before execution", async () => {
    const parameters = Schema.Struct({
      count: Schema.FiniteFromString,
    }).annotate({ parseOptions: { onExcessProperty: "error" } });
    expectTypeOf<Tool.DefWithoutID<typeof parameters>["execute"]>()
      .parameter(0)
      .toEqualTypeOf<{ readonly count: number }>();
    let calls = 0;
    const Counter = Tool.define(
      "counter",
      Effect.succeed({
        description: "Count",
        parameters,
        formatValidationError: () => "count must be a numeric string",
        execute: (args: typeof parameters.Type) => {
          return Effect.sync(() => {
            calls++;
            return output(args.count);
          });
        },
      }),
    );
    const definition = await Effect.runPromise(
      Effect.flatMap(Counter, Tool.init),
    );
    expect(
      await Effect.runPromise(definition.execute({ count: "3" }, context())),
    ).toEqual(output(3));
    for (const input of [
      null,
      [],
      { count: 3 },
      { count: "bad" },
      { count: "3", extra: true },
    ]) {
      const result = await Effect.runPromise(
        Effect.result(definition.execute(input, context())),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result))
        throw new Error("Expected invalid arguments");
      expect(result.failure).toBeInstanceOf(InvalidArgumentsError);
      expect(result.failure.tool).toBe("counter");
      expect(result.failure.message).toBe(
        "The counter tool was called with invalid arguments: count must be a numeric string.\nPlease rewrite the input so it satisfies the expected schema.",
      );
    }
    expect(calls).toBe(1);
  });

  test("preserves the exact structured outcome and never mutates the authored definition", async () => {
    const expected: Tool.ExecuteResult = {
      title: "Report",
      metadata: { count: 1 },
      output: {
        type: "content",
        value: [{ type: "text", text: "Report body" }],
      },
      evidence: [],
      attachments: [
        { type: "file", mime: "text/plain", url: "file:///report.txt" },
      ],
    };
    const authored: Tool.DefWithoutID<typeof Parameters> = Object.freeze({
      description: "Report",
      parameters: Parameters,
      execute: () => Effect.succeed(expected),
    });
    const definition = await Effect.runPromise(
      Tool.define("report", Effect.succeed(authored)).pipe(
        Effect.flatMap(Tool.init),
      ),
    );
    const actual = await Effect.runPromise(
      definition.execute({ count: 1 }, context()),
    );
    expect(actual).toBe(expected);
    expect(definition.execute).not.toBe(authored.execute);
    expect(Object.keys(authored)).toEqual([
      "description",
      "parameters",
      "execute",
    ]);
  });

  test("preserves setup, init, execution, and host callback failures", async () => {
    const failure = { kind: "denied" } as const;
    const failedSetup = Tool.define("failed", Effect.fail(failure));
    expect(await Effect.runPromise(Effect.result(failedSetup))).toEqual(
      Result.fail(failure),
    );

    const info = await Effect.runPromise(
      Tool.define(
        "failed-init",
        Effect.succeed(() => Effect.fail(failure)),
      ),
    );
    expect(await Effect.runPromise(Effect.result(Tool.init(info)))).toEqual(
      Result.fail(failure),
    );

    const failedExecution = await Effect.runPromise(
      Tool.define(
        "failed-execute",
        Effect.succeed({
          description: "Fail",
          parameters: Parameters,
          execute: () => Effect.fail(failure),
        }),
      ).pipe(Effect.flatMap(Tool.init)),
    );
    expectTypeOf<
      Effect.Error<ReturnType<typeof failedExecution.execute>>
    >().toEqualTypeOf<typeof failure | InvalidArgumentsError>();
    expect(
      await Effect.runPromise(
        Effect.result(failedExecution.execute({ count: 1 }, context())),
      ),
    ).toEqual(Result.fail(failure));

    let executed = false;
    const asks = await Effect.runPromise(
      Tool.define(
        "ask",
        Effect.succeed({
          description: "Ask",
          parameters: Parameters,
          execute: (_args: typeof Parameters.Type, ctx: Tool.Context) =>
            Effect.gen(function* () {
              yield* ctx.ask({
                permission: "read",
                patterns: [],
                metadata: {},
                always: [],
              });
              executed = true;
              return output(1);
            }),
        }),
      ).pipe(Effect.flatMap(Tool.init)),
    );
    expect(
      await Effect.runPromise(
        Effect.result(
          asks.execute(
            { count: 1 },
            { ...context(), ask: () => Effect.fail(failure) },
          ),
        ),
      ),
    ).toEqual(Result.fail(failure));
    expect(executed).toBe(false);
  });

  test("preserves defects without relabeling them as invalid arguments", async () => {
    const defect = new Error("Broken implementation");
    const definition = await Effect.runPromise(
      Tool.define(
        "broken",
        Effect.succeed({
          description: "Broken",
          parameters: Parameters,
          execute: () => Effect.die(defect),
        }),
      ).pipe(Effect.flatMap(Tool.init)),
    );
    const exit = await Effect.runPromiseExit(
      definition.execute({ count: 1 }, context()),
    );
    if (Exit.isSuccess(exit)) throw new Error("Expected a defect");
    expect(Cause.findDefect(exit.cause)).toEqual(Result.succeed(defect));
    expect(Cause.hasFails(exit.cause)).toBe(false);
  });

  test("interruption waits for implementation cleanup without becoming a tool failure", async () => {
    let released = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const info = yield* Tool.define(
          "waiting",
          Effect.succeed({
            description: "Wait",
            parameters: Parameters,
            execute: () =>
              Effect.acquireUseRelease(
                Deferred.succeed(started, undefined),
                () => Effect.never,
                () =>
                  Effect.sync(() => {
                    released = true;
                  }),
              ),
          }),
        );
        const definition = yield* Tool.init(info);
        const fiber = yield* definition
          .execute({ count: 1 }, context())
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);
        if (Exit.isSuccess(exit)) throw new Error("Expected interruption");
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(released).toBe(true);
      }),
    );
  });
});
