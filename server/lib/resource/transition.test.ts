// Purpose: Preserves transition result, failure, resolver-service, and Resource input types.

import { Database } from "@openchart/server/db";
import {
  agentScheduleResource,
  AgentScheduleId,
  type AgentSchedule,
} from "@openchart/server/resources/agent-schedule";
import { Context, Effect, Schema } from "effect";
import { expect, expectTypeOf, test, vi } from "vitest";

import type { StoreError, Tx } from "./store";
import * as Transition from "./transition";
import { run } from "./transactor";

class NameResolver extends Context.Service<
  NameResolver,
  { readonly name: string }
>()("Test.NameResolver") {}

test("threads resolved facts, errors, and services through the runner without adding apply services", () => {
  const transition = Transition.make({
    resolve: Effect.gen(function* () {
      const { name } = yield* NameResolver;
      if (!name) return yield* Effect.fail("resolve failed" as const);
      return { name };
    }),
    apply: (_tx, resolved) =>
      Effect.gen(function* () {
        if (resolved.name.length > 10) {
          return yield* Effect.fail("apply failed" as const);
        }
        return resolved.name.length;
      }),
  });
  const program = run(transition);
  expectTypeOf(program).toEqualTypeOf<
    Effect.Effect<
      number,
      Effect.Error<typeof program>,
      NameResolver | Database.Service
    >
  >();
  expectTypeOf<Effect.Error<typeof program>>().toExtend<
    "resolve failed" | "apply failed" | StoreError
  >();
  expectTypeOf<"resolve failed" | "apply failed">().toExtend<
    Effect.Error<typeof program>
  >();
  expectTypeOf<
    Effect.Services<ReturnType<typeof transition.apply>>
  >().toEqualTypeOf<never>();
  expectTypeOf<
    Effect.Effect<number, "apply failed", NameResolver>
  >().not.toExtend<ReturnType<typeof transition.apply>>();
});

test("binds input lazily and preserves distinct declaration inputs, results, and resolver services", async () => {
  const resolve = vi.fn((input: string) =>
    Effect.gen(function* () {
      const { name } = yield* NameResolver;
      return { name: `${name}: ${input}` };
    }),
  );
  const named = Transition.make({
    kind: "query",
    input: Schema.String,
    resolve,
    apply: (_tx, input, resolved) => {
      expectTypeOf(input).toEqualTypeOf<string>();
      expectTypeOf(resolved).toEqualTypeOf<{ name: string }>();
      return Effect.succeed(resolved.name);
    },
  });
  const count = Transition.make({
    input: Schema.Number,
    resolve: () => Effect.void,
    apply: (_tx, input) => Effect.succeed(input + 1),
  });
  expectTypeOf(named.kind).toEqualTypeOf<"query" | undefined>();
  expectTypeOf(count.kind).toEqualTypeOf<"mutation" | undefined>();
  const bound = Transition.bind({ named, count });
  const operation = bound.named("input");
  const direct = Transition.bindInput(named, "direct");
  const apply = vi.spyOn(named, "apply");
  expectTypeOf(direct).toEqualTypeOf<typeof operation>();
  expect(resolve).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expectTypeOf<Parameters<typeof bound.named>[0]>().toEqualTypeOf<string>();
  expectTypeOf<Parameters<typeof bound.count>[0]>().toEqualTypeOf<number>();
  expectTypeOf<
    Effect.Success<ReturnType<ReturnType<typeof bound.count>["apply"]>>
  >().toEqualTypeOf<number>();
  expectTypeOf<
    Effect.Services<typeof operation.resolve>
  >().toEqualTypeOf<NameResolver>();
  await expect(
    Effect.runPromise(
      operation.resolve.pipe(
        Effect.provideService(NameResolver, { name: "Resolved" }),
      ),
    ),
  ).resolves.toEqual({ name: "Resolved: input" });
  expect(resolve).toHaveBeenCalledExactlyOnceWith("input");
  const resolved = await Effect.runPromise(
    direct.resolve.pipe(
      Effect.provideService(NameResolver, { name: "Resolved" }),
    ),
  );
  const tx = {} as Tx;
  await expect(Effect.runPromise(direct.apply(tx, resolved))).resolves.toBe(
    "Resolved: direct",
  );
  expect(apply).toHaveBeenCalledExactlyOnceWith(tx, "direct", resolved);
});

test("intrinsic transitions retain concrete entity, branded id, writable input, and patch types", () => {
  const create = agentScheduleResource.transitions.create({
    name: "Typed",
    enabled: false,
    target: {
      kind: "agent_prompt",
      prompt: {
        agent: "analyst",
        model: { providerID: "codex", modelID: "tier1" },
        parts: [{ type: "text", text: "Typed" }],
      },
    },
    recurrence: { kind: "once", fireAt: "2090-01-01T00:00:00.000Z" },
  });
  expectTypeOf(create).toEqualTypeOf<
    Transition.Transition<void, AgentSchedule, never, StoreError>
  >();
  expectTypeOf<
    Parameters<typeof agentScheduleResource.transitions.get>[0]
  >().toEqualTypeOf<typeof AgentScheduleId.Type>();
  expectTypeOf<
    Parameters<typeof agentScheduleResource.transitions.create>[0]
  >().toEqualTypeOf<
    | typeof agentScheduleResource.createSchema.Type
    | typeof agentScheduleResource.body.Type
  >();
  expectTypeOf<
    Parameters<typeof agentScheduleResource.transitions.create>[0]
  >().toExtend<{ readonly name: string; readonly enabled: boolean }>();
  expectTypeOf<
    Parameters<typeof agentScheduleResource.transitions.patch>[0]["id"]
  >().toEqualTypeOf<typeof AgentScheduleId.Type>();
  expectTypeOf<
    Effect.Success<ReturnType<typeof create.apply>>
  >().toEqualTypeOf<AgentSchedule>();
  expectTypeOf<Effect.Services<typeof create.resolve>>().toEqualTypeOf<never>();
});
