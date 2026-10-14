// Purpose: Verify phase scope, live publication, failure propagation and cancellation cleanup.
import { Deferred, Effect, Fiber, Schema } from "effect";
import { expect, test } from "vitest";
import { phase } from "@openchart/server/agent/workflow/authoring";
import { withWorkflowTracing } from "./tracing";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                spanId: Schema.String,
                parentSpanId: Schema.optional(Schema.String),
                name: Schema.String,
                endTimeUnixNano: Schema.String,
                status: Schema.Struct({ code: Schema.Number }),
                attributes: Schema.Array(
                  Schema.Struct({
                    key: Schema.String,
                    value: Schema.JsonObject,
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const spans = (trace: unknown) =>
  decode(trace).resourceSpans.flatMap((r) =>
    r.scopeSpans.flatMap((s) => s.spans),
  );

test("phases publish before execution, compose sequential effects, and isolate concurrent parentage", async () => {
  const snapshots: Schema.JsonObject[] = [];
  const program = phase(
    "Research",
    Effect.gen(function* () {
      expect(spans(snapshots.at(-1))).toMatchObject([
        { name: "Workflow.phase", endTimeUnixNano: "0" },
      ]);
      const first = yield* Effect.succeed(2);
      const next = yield* Effect.all(
        [1, 2].map((n) =>
          phase("Review", phase(`Check ${n}`, Effect.succeed(n))),
        ),
        { concurrency: "unbounded" },
      );
      return { first, next };
    }),
  );
  // Constructing a phase is lazy.
  expect(snapshots).toEqual([]);
  expect(
    await Effect.runPromise(
      withWorkflowTracing(program, (trace) =>
        Effect.sync(() => {
          snapshots.push(trace);
        }),
      ),
    ),
  ).toEqual({ first: 2, next: [1, 2] });
  const final = spans(snapshots.at(-1));
  expect(final).toHaveLength(5);
  expect(new Set(final.map((s) => s.spanId)).size).toBe(5);
  const label = (s: (typeof final)[number]) =>
    s.attributes.find((a) => a.key === "openchart.label")?.value.stringValue;
  const root = final.find((s) => label(s) === "Research")!;
  const reviews = final.filter((s) => label(s) === "Review");
  expect(reviews.every((s) => s.parentSpanId === root.spanId)).toBe(true);
  const checks = final.filter((s) => String(label(s)).startsWith("Check"));
  expect(new Set(checks.map((s) => s.parentSpanId))).toEqual(
    new Set(reviews.map((s) => s.spanId)),
  );
  expect(
    final.every((s) => s.status.code === 1 && BigInt(s.endTimeUnixNano) > 0n),
  ).toBe(true);
});

test("phase failures propagate unchanged and publish the closed span", async () => {
  const error = new Error("Unavailable");
  let last: unknown;
  const result = await Effect.runPromise(
    withWorkflowTracing(phase("Research", Effect.fail(error)), (trace) =>
      Effect.sync(() => {
        last = trace;
      }),
    ).pipe(Effect.flip),
  );
  expect(result).toBe(error);
  expect(spans(last)[0]?.status.code).toBe(2);
  expect(BigInt(spans(last)[0]!.endTimeUnixNano)).toBeGreaterThan(0n);
});

test("phase cancellation joins cleanup before publishing its terminal state", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let cleaned = false;
        let last: unknown;
        const work = Effect.gen(function* () {
          yield* Deferred.succeed(ready, undefined);
          yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              cleaned = true;
            }),
          ),
        );
        const fiber = yield* Effect.forkChild(
          withWorkflowTracing(phase("Research", work), (trace) =>
            Effect.sync(() => {
              last = trace;
              if (spans(trace)[0]?.endTimeUnixNano !== "0")
                expect(cleaned).toBe(true);
            }),
          ),
        );
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
        expect(cleaned).toBe(true);
        expect(spans(last)[0]?.attributes).toContainEqual({
          key: "openchart.cancelled",
          value: { boolValue: true },
        });
        expect(BigInt(spans(last)[0]!.endTimeUnixNano)).toBeGreaterThan(0n);
      }),
    ),
  );
});
