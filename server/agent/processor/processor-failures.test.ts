// Purpose: Verifies processor retries, cancellation, and failure cleanup through real persistence.

import { APICallError } from "@ai-sdk/provider";
import {
  ANTIGRAVITY,
  CLAUDE_CODE,
  CODEX,
  GROK,
} from "@openchart/models/model-tiers";
import { StoreNotFound } from "@openchart/server/agent/errors";
import { RequestFailed } from "@openchart/server/agent/llm/errors";
import { CorrectedError } from "@openchart/server/agent/permission/errors";
import { Session } from "@openchart/server/agent/session/session";
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, test } from "vitest";
import { Processor } from "./processor";
import type { Tool } from "@openchart/server/agent/tool/tool";
import { assertExists } from "@openchart/utils/assert";
import {
  finish,
  finishStep,
  model,
  run,
  streamOf,
} from "./processor.test-utils";

function transient() {
  return new RequestFailed({
    cause: new APICallError({
      message: "Provider unavailable",
      url: "https://provider.example",
      requestBodyValues: {},
      statusCode: 503,
    }),
  });
}

const activeParts = () =>
  streamOf(
    { type: "start-step" },
    { type: "text-start", id: "text" },
    { type: "text-delta", id: "text", text: "Unfinished text  " },
    { type: "tool-input-start", id: "tool", toolName: "echo" },
    { type: "tool-call", toolCallId: "tool", toolName: "echo", input: {} },
  );

const blockedTool = {
  description: "Must not execute before a ToolPart commits",
  parameters: Schema.Struct({}),
  execute: () =>
    Effect.die(new Error("Tool executed without a committed Part")),
};

describe("processor failure lifecycle", () => {
  test.each(
    [CODEX, CLAUDE_CODE, ANTIGRAVITY, GROK].flatMap((providerID) =>
      ["completed", "failed", "stop"].map((outcome) => ({
        providerID,
        outcome,
      })),
    ),
  )(
    "native $providerID waits through silence until $outcome",
    ({ providerID, outcome }) =>
      run((f) =>
        Effect.gen(function* () {
          const selected = { ...model, providerID };
          const assistant = { ...f.assistant, providerID };
          yield* f.session.updateMessage(assistant);
          const terminal = yield* Deferred.make<void>();
          let released = false;
          f.source = () =>
            streamOf({ type: "start-step" }).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.await(terminal)).pipe(
                  Stream.flatMap(() =>
                    outcome === "failed"
                      ? Stream.fail(transient())
                      : streamOf(finishStep(), finish),
                  ),
                ),
              ),
              Stream.ensuring(Effect.sync(() => (released = true))),
            );
          const processor = yield* Processor.create({
            assistantMessage: assistant,
            model: selected,
          });
          const running = yield* Effect.forkChild(
            processor.process({ ...f.request, model: selected }),
          );
          yield* TestClock.adjust(300_000);
          expect(running.pollUnsafe()).toBeUndefined();
          if (outcome === "stop") yield* Fiber.interrupt(running);
          else yield* Deferred.succeed(terminal, undefined);
          const exit = yield* Fiber.await(running);
          expect(Exit.isSuccess(exit)).toBe(outcome === "completed");
          if (outcome === "stop" && Exit.isFailure(exit))
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          const saved = yield* f.session.getMessage({
            sessionID: assistant.sessionID,
            messageID: assistant.id,
          });
          expect(saved?.info).toMatchObject({
            time: { completed: 300_000 },
            ...(outcome === "completed"
              ? { finish: "stop" }
              : {
                  error: {
                    name:
                      outcome === "failed" ? "APIError" : "MessageAbortedError",
                  },
                }),
          });
          expect(released).toBe(true);
          expect(f.calls).toHaveLength(1);
        }),
      ),
  );

  test.each(["text", "reasoning"] as const)(
    "empty %s progress resets idle without writes, then genuine silence times out",
    (type) =>
      run((f) =>
        Effect.gen(function* () {
          let writes = 0;
          const session: Session.Interface = {
            ...f.session,
            updatePart: (part) => {
              if (part.type === type) writes++;
              return f.session.updatePart(part);
            },
          };
          f.source = () =>
            streamOf(
              { type: "start-step" },
              {
                type: `${type}-start`,
                id: "thinking",
                providerMetadata: { claudeCode: { phase: "thinking" } },
              },
            ).pipe(
              Stream.concat(
                Stream.fromIterable([undefined, "thinking", "thinking"]).pipe(
                  Stream.mapEffect((phase) =>
                    Effect.sleep(45_000).pipe(
                      Effect.as({
                        type: `${type}-delta`,
                        id: "thinking",
                        text: "",
                        providerMetadata: phase
                          ? { claudeCode: { phase } }
                          : undefined,
                      } as const),
                    ),
                  ),
                ),
              ),
              Stream.concat(Stream.never),
            );
          const processor = yield* Processor.create({
            assistantMessage: f.assistant,
            model,
          }).pipe(Effect.provideService(Session.Service, session));
          const running = yield* Effect.forkChild(
            processor.process(f.request).pipe(Effect.flip),
          );
          yield* TestClock.adjust(135_000);
          expect(running.pollUnsafe()).toBeUndefined();
          expect(writes).toBe(0);
          yield* TestClock.adjust(119_999);
          expect(running.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust(1);
          expect(yield* Fiber.join(running)).toMatchObject({
            name: "APIError",
            data: { message: "Model stream produced no events for 120000 ms" },
          });
          expect(writes).toBe(1);
          expect(f.calls).toHaveLength(1);
          const saved = yield* f.session.getMessage({
            sessionID: f.assistant.sessionID,
            messageID: f.assistant.id,
          });
          expect(saved?.parts.find((part) => part.type === type)).toMatchObject(
            {
              text: "",
              time: { start: 0, end: 255_000 },
            },
          );
        }),
      ),
  );

  test("silent pending tool input times out and is cleaned up without replay", () =>
    run((f) =>
      Effect.gen(function* () {
        f.source = () =>
          streamOf(
            { type: "start-step" },
            { type: "tool-input-start", id: "pending", toolName: "echo" },
          ).pipe(Stream.concat(Stream.never));
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        const running = yield* Effect.forkChild(
          processor.process(f.request).pipe(Effect.flip),
        );
        yield* TestClock.adjust(119_999);
        expect(running.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(running)).toMatchObject({ name: "APIError" });
        expect(f.calls).toHaveLength(1);
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.info).toMatchObject({
          error: { name: "APIError" },
          time: { completed: 120_000 },
        });
        expect(saved?.parts.find((part) => part.type === "tool")).toMatchObject(
          {
            state: { status: "error", time: { end: 120_000 } },
          },
        );
      }),
    ));

  test("tool-error projection preserves permission feedback through the generic Error interface", () =>
    run((f) =>
      Effect.gen(function* () {
        const feedback = "Use /public/report.md instead.";
        const corrected = new CorrectedError({ feedback });
        f.source = () =>
          streamOf(
            { type: "start-step" },
            { type: "tool-input-start", id: "tool", toolName: "echo" },
            {
              type: "tool-call",
              toolCallId: "tool",
              toolName: "echo",
              input: {},
            },
            {
              type: "tool-error",
              toolCallId: "tool",
              toolName: "echo",
              input: {},
              error: corrected,
            },
            finishStep(),
            finish,
          );
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        expect(yield* processor.process(f.request)).toBeUndefined();
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.parts.find((part) => part.type === "tool")).toMatchObject(
          {
            state: { status: "error", error: corrected.message },
          },
        );
        expect(corrected.message).toContain(feedback);
      }),
    ));

  test("retries three times before projection with 2, 4, 8 second delays", () =>
    run((f) =>
      Effect.gen(function* () {
        f.source = () => Stream.fail(transient());
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        const running = yield* Effect.forkChild(
          processor.process(f.request).pipe(Effect.flip),
        );

        yield* TestClock.adjust(1_999);
        expect(f.calls).toHaveLength(1);
        yield* TestClock.adjust(1);
        expect(f.calls).toHaveLength(2);
        yield* TestClock.adjust(3_999);
        expect(f.calls).toHaveLength(2);
        yield* TestClock.adjust(1);
        expect(f.calls).toHaveLength(3);
        yield* TestClock.adjust(7_999);
        expect(f.calls).toHaveLength(3);
        yield* TestClock.adjust(1);
        const error = yield* Fiber.join(running);
        expect(f.calls).toHaveLength(4);
        expect(f.calls.every((call) => call.retries === 0)).toBe(true);
        expect(error).toMatchObject({
          name: "APIError",
          data: { statusCode: 503 },
        });
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.info).toMatchObject({
          error: { name: "APIError", data: { statusCode: 503 } },
          time: { completed: 14_000 },
        });
        expect(saved?.parts).toEqual([]);
      }),
    ));

  test("cancels backoff immediately without starting another request", () =>
    run((f) =>
      Effect.gen(function* () {
        f.source = () => Stream.fail(transient());
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        const running = yield* Effect.forkChild(processor.process(f.request));
        yield* TestClock.adjust(1_000);
        expect(f.calls).toHaveLength(1);
        yield* Fiber.interrupt(running);
        const result = yield* Fiber.await(running);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.hasInterrupts(result.cause)).toBe(true);
        yield* TestClock.adjust(60_000);
        expect(f.calls).toHaveLength(1);
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.info).toMatchObject({
          error: { name: "MessageAbortedError" },
        });
      }),
    ));

  test("does not replay a projected start-step", () =>
    run((f) =>
      Effect.gen(function* () {
        f.source = () =>
          streamOf({ type: "start-step" }).pipe(
            Stream.concat(Stream.fail(transient())),
          );
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        expect(
          yield* processor.process(f.request).pipe(Effect.flip),
        ).toMatchObject({ name: "APIError" });
        expect(f.calls).toHaveLength(1);
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.parts.map((part) => part.type)).toEqual(["step-start"]);
      }),
    ));

  test("does not replay a permission callback completed before stream projection", () =>
    run((f) =>
      Effect.gen(function* () {
        let executions = 0;
        f.source = (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* request.askPermission!({
                permission: "read",
                patterns: ["/report"],
                metadata: {},
                always: [],
              }).pipe(Effect.orDie);
              return Stream.fail(transient());
            }),
          );
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        const result = yield* processor
          .process({
            ...f.request,
            askPermission: () =>
              Effect.sync(() => {
                executions++;
              }),
          })
          .pipe(Effect.flip);
        expect(result).toMatchObject({ name: "APIError" });
        expect(executions).toBe(1);
        expect(f.calls).toHaveLength(1);
      }),
    ));

  test("a callback without tool-input-start never executes or disables the idle deadline", () =>
    run((f) =>
      Effect.gen(function* () {
        let executions = 0;
        let closed = 0;
        const callbacks: Fiber.Fiber<void>[] = [];
        f.source = (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const callback = yield* request.tools
                .echo!.execute({}, { toolCallId: "missing" })
                .pipe(
                  Effect.asVoid,
                  Effect.orDie,
                  Effect.ensuring(
                    Effect.sync(() => {
                      closed++;
                    }),
                  ),
                  Effect.forkScoped,
                );
              callbacks.push(callback);
              return Stream.never;
            }),
          );
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        const running = yield* Effect.forkChild(
          processor
            .process({
              ...f.request,
              tools: {
                echo: {
                  description: "Echo",
                  parameters: Schema.Struct({}),
                  execute: () =>
                    Effect.sync(() => {
                      executions++;
                      return {
                        title: "Echo",
                        metadata: {},
                        output: { type: "text" as const, value: "done" },
                      };
                    }),
                },
              },
            })
            .pipe(Effect.flip),
        );
        yield* TestClock.adjust(119_999);
        expect(f.calls).toHaveLength(1);
        expect(running.pollUnsafe()).toBeUndefined();
        expect(executions).toBe(0);
        yield* TestClock.adjust(1);
        expect(closed).toBe(1);
        yield* TestClock.adjust(2_000);
        expect(f.calls).toHaveLength(2);
        yield* TestClock.adjust(372_000);
        expect(yield* Fiber.join(running)).toMatchObject({ name: "APIError" });
        expect(f.calls).toHaveLength(4);
        expect(executions).toBe(0);
        expect(closed).toBe(4);
        for (const callback of callbacks) {
          const exit = yield* Fiber.await(callback);
          expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
            true,
          );
        }
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.parts).toEqual([]);
        expect(saved?.info).toMatchObject({
          error: { name: "APIError" },
          time: { completed: 494_000 },
        });
      }),
    ));

  test("request-snapshot storage failures retain their original error identity", () =>
    run((f) =>
      Effect.gen(function* () {
        const failure = new StoreNotFound({
          entity: "message",
          id: f.assistant.id,
        });
        let requested = false;
        f.source = () => {
          requested = true;
          return Stream.never;
        };
        const session: Session.Interface = {
          ...f.session,
          updateMessage: (info) =>
            info.role === "assistant" && info.request
              ? Effect.fail(failure)
              : f.session.updateMessage(info),
        };
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        }).pipe(Effect.provideService(Session.Service, session));
        expect(yield* processor.process(f.request).pipe(Effect.flip)).toBe(
          failure,
        );
        expect(requested).toBe(false);
        expect(f.calls).toHaveLength(1);
      }),
    ));

  test("interruption flushes text, terminates tools, and releases unresolved waiters", () =>
    run((f) =>
      Effect.gen(function* () {
        let waiting: Fiber.Fiber<Tool.ExecuteResult, unknown> | undefined;
        f.source = (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              waiting = yield* request.tools
                .echo!.execute({}, { toolCallId: "absent" })
                .pipe(Effect.forkScoped);
              return activeParts().pipe(Stream.concat(Stream.never));
            }),
          );
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        const running = yield* Effect.forkChild(
          processor.process({ ...f.request, tools: { echo: blockedTool } }),
        );
        yield* TestClock.adjust(1);
        assertExists(waiting, "Model request started its tool waiter");
        yield* TestClock.adjust(0);
        expect(waiting.pollUnsafe()).toBeUndefined();
        const before = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(
          before?.parts.find((part) => part.type === "text"),
        ).toMatchObject({
          text: "Unfinished text  ",
        });

        yield* Fiber.interrupt(running);
        const stopped = yield* Fiber.await(running);
        const released = yield* Fiber.await(waiting);
        expect(Exit.isFailure(stopped)).toBe(true);
        expect(Exit.isFailure(released)).toBe(true);
        if (Exit.isFailure(stopped))
          expect(Cause.hasInterrupts(stopped.cause)).toBe(true);
        if (Exit.isFailure(released))
          expect(Cause.hasInterrupts(released.cause)).toBe(true);
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.info).toMatchObject({
          error: { name: "MessageAbortedError" },
          time: { completed: 1 },
        });
        expect(saved?.parts.find((part) => part.type === "text")).toMatchObject(
          {
            text: "Unfinished text  ",
            time: { end: 1 },
          },
        );
        expect(saved?.parts.find((part) => part.type === "tool")).toMatchObject(
          {
            state: { status: "error", time: { end: 1 } },
          },
        );
        expect(f.calls).toHaveLength(1);
      }),
    ));

  test("a cleanup write failure preserves the model cause and attempts other writes", () =>
    run((f) =>
      Effect.gen(function* () {
        const storage = new StoreNotFound({ entity: "part", id: "text" });
        const releaseFailure = yield* Deferred.make<void>();
        let waiting: Fiber.Fiber<Tool.ExecuteResult, unknown> | undefined;
        f.source = (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              waiting = yield* request.tools
                .echo!.execute({}, { toolCallId: "absent" })
                .pipe(Effect.forkScoped);
              return activeParts().pipe(
                Stream.concat(
                  Stream.fromEffect(
                    Deferred.await(releaseFailure).pipe(
                      Effect.andThen(Effect.fail(transient())),
                    ),
                  ),
                ),
              );
            }),
          );
        const session: Session.Interface = {
          ...f.session,
          updatePart: (part) =>
            part.type === "text" && part.time?.end !== undefined
              ? Effect.fail(storage)
              : f.session.updatePart(part),
        };
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        }).pipe(Effect.provideService(Session.Service, session));
        const running = yield* Effect.forkChild(
          processor.process({ ...f.request, tools: { echo: blockedTool } }),
        );
        yield* TestClock.adjust(0);
        assertExists(waiting, "Model request started its tool waiter");
        yield* TestClock.adjust(0);
        expect(waiting.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseFailure, undefined);
        const result = yield* Fiber.await(running);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const errors = result.cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error);
          expect(errors).toContain(storage);
          expect(errors).toContainEqual(
            expect.objectContaining({ name: "APIError" }),
          );
        }
        const released = yield* Fiber.await(waiting);
        expect(Exit.isFailure(released)).toBe(true);
        if (Exit.isFailure(released))
          expect(Cause.hasInterrupts(released.cause)).toBe(true);
        const saved = yield* f.session.getMessage({
          sessionID: f.assistant.sessionID,
          messageID: f.assistant.id,
        });
        expect(saved?.info).toMatchObject({ error: { name: "APIError" } });
        expect(saved?.parts.find((part) => part.type === "tool")).toMatchObject(
          {
            state: { status: "error" },
          },
        );
      }),
    ));

  test("retains source defects without reclassifying them as model failures", () =>
    run((f) =>
      Effect.gen(function* () {
        const defect = new TypeError("broken provider invariant");
        f.source = () => Stream.die(defect);
        const processor = yield* Processor.create({
          assistantMessage: f.assistant,
          model,
        });
        const result = yield* processor.process(f.request).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(
            result.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect),
          ).toContain(defect);
        }
        expect(f.calls).toHaveLength(1);
      }),
    ));
});

test("question waits outlive the idle deadline and are not replayed after an answer", () =>
  run((f) =>
    Effect.gen(function* () {
      const answer = yield* Deferred.make<void>();
      let asked = 0;
      f.source = (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* request.askQuestion!({ questions: [] }).pipe(Effect.orDie);
            return Stream.fail(transient());
          }),
        );
      const processor = yield* Processor.create({
        assistantMessage: f.assistant,
        model,
      });
      const running = yield* processor
        .process({
          ...f.request,
          askQuestion: () =>
            Effect.gen(function* () {
              asked++;
              yield* Deferred.await(answer);
              return { type: "skipped" as const };
            }),
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(120_000);
      expect(asked).toBe(1);
      expect(running.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(answer, undefined);
      expect(yield* Fiber.join(running)).toMatchObject({ name: "APIError" });
      expect(f.calls).toHaveLength(1);
    }),
  ));
