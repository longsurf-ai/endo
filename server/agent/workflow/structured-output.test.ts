// Purpose: Checks typed workflow outputs and caller-owned repair after invalid answers.

import { Effect, Schema } from "effect";
import { expect, expectTypeOf, test, vi } from "vitest";
import {
  agent,
  defineWorkflow,
  InvalidOutput,
  InvalidOutputSchema,
  textPrompt,
} from "@openchart/server/agent/workflow/authoring";
import { run } from "./runtime";
import { Workflow } from "./workflow";

const prompt = textPrompt(
  "Review",
  { providerID: "codex", modelID: "tier1" },
  "analyst",
);
const Review = Schema.Struct({
  passed: Schema.Boolean,
  missingEvidence: Schema.Array(Schema.String),
});

test("infers validated output and keeps text output typed as string", async () => {
  const call = vi.fn<Workflow.Service["Service"]["agent"]>(
    (_input, _onSession, options) =>
      Effect.succeed({
        sessionId: "child",
        output: options?.outputSchema
          ? JSON.stringify({ passed: true, missingEvidence: [] })
          : "Plain answer",
      }),
  );
  const definition = defineWorkflow({
    description: "Typed outputs",
    args: Schema.Struct({}),
    run: () =>
      Effect.gen(function* () {
        const review = yield* agent(prompt, { schema: Review });
        expectTypeOf(review.output).toEqualTypeOf<typeof Review.Type>();
        expect(review).toEqual({
          sessionId: "child",
          output: { passed: true, missingEvidence: [] },
        });
        const plain = yield* agent(prompt, { sessionId: review.sessionId });
        expectTypeOf(plain.output).toEqualTypeOf<string>();
        expect(plain.output).toBe("Plain answer");
        return review;
      }),
  });
  await Effect.runPromise(
    run(definition, {}).pipe(
      Effect.provideService(Workflow.Service, {
        getResource: () => Effect.die("Unexpected Resource read"),
        parentPrompt: prompt,
        settings: { concurrency: 1 },
        agent: call,
      }),
    ),
  );
  expect(call.mock.calls[0]![2]?.outputSchema).toMatchObject({
    type: "object",
    required: ["passed", "missingEvidence"],
  });
  expect(call.mock.calls[1]![2]?.outputSchema).toBeUndefined();
});

test.each([
  "not json",
  '{"passed":"yes","missingEvidence":[]}',
  '{"passed":true,"missingEvidence":[],"extra":1}',
])(
  "returns session identity on invalid output without retrying: %s",
  async (invalid) => {
    const call = vi.fn<Workflow.Service["Service"]["agent"]>(() =>
      Effect.succeed({ sessionId: "repairable", output: invalid }),
    );
    await Effect.runPromise(
      run(
        defineWorkflow({
          description: "Caller-owned repair",
          args: Schema.Struct({}),
          run: () =>
            Effect.gen(function* () {
              const error = yield* agent(prompt, { schema: Review }).pipe(
                Effect.flip,
              );
              expect(Schema.is(InvalidOutput)(error)).toBe(true);
              if (!Schema.is(InvalidOutput)(error))
                return yield* Effect.die(error);
              expect(error.sessionId).toBe("repairable");
              expect(error.message.length).toBeGreaterThan(0);
              expect(call).toHaveBeenCalledTimes(1);
              call.mockImplementation(() =>
                Effect.succeed({
                  sessionId: "repairable",
                  output: '{"passed":true,"missingEvidence":[]}',
                }),
              );
              const repaired = yield* agent(prompt, {
                schema: Review,
                sessionId: error.sessionId,
              });
              expect(repaired.output.passed).toBe(true);
              return repaired;
            }),
        }),
        {},
      ).pipe(
        Effect.provideService(Workflow.Service, {
          getResource: () => Effect.die("Unexpected Resource read"),
          parentPrompt: prompt,
          settings: { concurrency: 1 },
          agent: call,
        }),
      ),
    );
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]![2]?.sessionId).toBe("repairable");
  },
);

test("projects referenced encoded shapes and validates transformed outputs", async () => {
  const Count = Schema.Struct({ count: Schema.FiniteFromString }).annotate({
    identifier: "Count",
  });
  const Counts = Schema.Struct({ first: Count, second: Count });
  const call = vi.fn<Workflow.Service["Service"]["agent"]>(() =>
    Effect.succeed({
      sessionId: "transformed",
      output: '{"first":{"count":"42"},"second":{"count":"7"}}',
    }),
  );
  await Effect.runPromise(
    run(
      defineWorkflow({
        description: "Transformed output",
        args: Schema.Struct({}),
        run: () =>
          Effect.gen(function* () {
            const result = yield* agent(prompt, { schema: Counts });
            expectTypeOf(result.output.first.count).toEqualTypeOf<number>();
            expect(result.output).toEqual({
              first: { count: 42 },
              second: { count: 7 },
            });
            call.mockImplementation(() =>
              Effect.succeed({
                sessionId: "transformed",
                output: '{"first":{"count":"NaN"},"second":{"count":"7"}}',
              }),
            );
            const error = yield* agent(prompt, {
              schema: Counts,
              sessionId: result.sessionId,
            }).pipe(Effect.flip);
            expect(Schema.is(InvalidOutput)(error)).toBe(true);
            expect(error).toMatchObject({ sessionId: result.sessionId });
            return result;
          }),
      }),
      {},
    ).pipe(
      Effect.provideService(Workflow.Service, {
        getResource: () => Effect.die("Unexpected Resource read"),
        parentPrompt: prompt,
        settings: { concurrency: 1 },
        agent: call,
      }),
    ),
  );
  expect(call).toHaveBeenCalledTimes(2);
  expect(call.mock.calls[0]![2]?.outputSchema).toMatchObject({
    properties: {
      first: { $ref: "#/definitions/Count" },
      second: { $ref: "#/definitions/Count" },
    },
    definitions: {
      Count: { type: "object", properties: { count: { type: "string" } } },
    },
  });
});

test("reports projection failures before starting an agent", async () => {
  const Broken = Schema.suspend((): typeof Schema.String => {
    throw new Error("Schema unavailable");
  });
  const call = vi.fn<Workflow.Service["Service"]["agent"]>(() =>
    Effect.die("Must not run"),
  );
  await Effect.runPromise(
    run(
      defineWorkflow({
        description: "Unsupported output schema",
        args: Schema.Struct({}),
        run: () =>
          agent(prompt, {
            schema: Schema.Struct({ count: Broken }),
          }).pipe(
            Effect.flip,
            Effect.map((error) => {
              expect(Schema.is(InvalidOutputSchema)(error)).toBe(true);
              expect(error).toMatchObject({
                message: "Error: Schema unavailable",
              });
              return null;
            }),
          ),
      }),
      {},
    ).pipe(
      Effect.provideService(Workflow.Service, {
        getResource: () => Effect.die("Unexpected Resource read"),
        parentPrompt: prompt,
        settings: { concurrency: 1 },
        agent: call,
      }),
    ),
  );
  expect(call).not.toHaveBeenCalled();
});
