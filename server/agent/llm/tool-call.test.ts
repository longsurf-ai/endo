// Purpose: Verifies deterministic sources through Processor's real persistence and cleanup path.

import { Processor } from "@openchart/server/agent/processor/processor";
import {
  model,
  readToolPart,
  run,
} from "@openchart/server/agent/processor/processor.test-utils";
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vitest";
import { LLM } from "./llm";
import { toolCallStream } from "./tool-call";

test.each(["success", "error", "defect", "interrupt"] as const)(
  "deterministic %s uses committed callbacks and awaits scoped cleanup",
  async (outcome) => {
    await run((fixture) =>
      Effect.gen(function* () {
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        const ready = yield* Deferred.make<void>();
        const failure = new Error("Tool failure");
        const args = { question: "Exact accepted input" };
        let cleaned = false;
        const fiber = yield* Effect.forkChild(
          processor
            .process({
              ...fixture.request,
              tools: {
                probe: {
                  description: "Test tool",
                  parameters: Schema.Struct({ question: Schema.String }),
                  execute: (input) =>
                    Effect.gen(function* () {
                      expect(input).toEqual(args);
                      expect(
                        (yield* readToolPart(fixture, "call")).state.status,
                      ).toBe("running");
                      yield* Effect.addFinalizer(() =>
                        Effect.sync(() => {
                          cleaned = true;
                        }),
                      );
                      yield* processor.updateToolProgress("call", {
                        metadata: { preparedArgs: args },
                      });
                      yield* Deferred.succeed(ready, undefined);
                      if (outcome === "error")
                        return yield* Effect.fail(failure);
                      if (outcome === "defect")
                        return yield* Effect.die(failure);
                      if (outcome === "interrupt") return yield* Effect.never;
                      // A running tool may exceed the ordinary 120-second idle deadline.
                      yield* Effect.sleep("3 minutes");
                      return {
                        title: "Result",
                        metadata: { complete: true },
                        output: { type: "text" as const, value: "Done" },
                      };
                    }),
                },
              },
            })
            .pipe(
              Effect.provideService(
                LLM.Service,
                toolCallStream({
                  toolName: "probe",
                  callID: "call",
                  args,
                }),
              ),
            ),
        );
        yield* Deferred.await(ready);
        if (outcome === "interrupt") yield* Fiber.interrupt(fiber);
        if (outcome === "success") yield* TestClock.adjust("3 minutes");
        const exit = yield* Fiber.await(fiber);
        expect(cleaned).toBe(true);
        expect(fixture.calls).toEqual([]);
        const part = yield* readToolPart(fixture, "call");
        expect(part.state.status).toBe(
          outcome === "success" ? "completed" : "error",
        );
        expect(part.state.metadata?.preparedArgs).toEqual({
          question: "Exact accepted input",
        });
        if (outcome === "error" || outcome === "success") {
          expect(Exit.isSuccess(exit)).toBe(true);
        } else {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBe(outcome === "defect");
            expect(Cause.hasInterrupts(exit.cause)).toBe(
              outcome === "interrupt",
            );
          }
        }
        const saved = yield* fixture.session.getMessage({
          sessionID: fixture.assistant.sessionID,
          messageID: fixture.assistant.id,
        });
        expect(saved?.info).toMatchObject({
          role: "assistant",
          time: { completed: expect.any(Number) },
        });
        if (saved?.info.role === "assistant") {
          expect(saved.info.cost).toBe(0);
          expect(saved.info.tokens.input).toBe(0);
          expect(saved.info.tokens.output).toBe(0);
        }
      }).pipe(Effect.scoped),
    );
  },
);
