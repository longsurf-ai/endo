import { unusedModelSetup } from "@openchart/server/models/models.test-utils";
// Purpose: Exercises Processor through the real AI SDK and scoped LLM callback bridge.

import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { LLM } from "@openchart/server/agent/llm/llm";
import { Models } from "@openchart/server/models";
import { Database } from "@openchart/server/db";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { expect, test } from "vitest";
import { Processor } from "./processor";
import { model, readToolPart, run } from "./processor.test-utils";

function language(
  parts: LanguageModelV4StreamPart[],
  before?: () => Promise<void>,
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "openai",
    modelId: model.id,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Unexpected doGenerate");
    },
    doStream: async () => {
      await before?.();
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

function llmLayer(value: LanguageModelV4) {
  const models: Models.Interface = {
    ...unusedModelSetup,
    list: () => Effect.succeed([]),
    getModel: () => Effect.succeed(model),
    getLanguage: () => Effect.succeed(value),
  };
  return LLM.layer.pipe(
    Layer.provideMerge(Layer.succeed(Models.Service, models)),
  );
}

const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2, reasoning: 0 },
  },
};
const toolEvents: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "tool-input-start", id: "call", toolName: "echo" },
  { type: "tool-input-delta", id: "call", delta: "{}" },
  { type: "tool-input-end", id: "call" },
  { type: "tool-call", toolCallId: "call", toolName: "echo", input: "{}" },
  { ...finish, finishReason: { unified: "tool-calls", raw: "tool_calls" } },
];

test("real LLM persists the prepared request before SDK I/O and projects text", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const runCallback = Effect.runPromiseWith(
        yield* Effect.context<Database.Service>(),
      );
      let observedSnapshot = false;
      const native = language(
        [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "Hello" },
          { type: "text-end", id: "text" },
          finish,
        ],
        async () => {
          const saved = await runCallback(
            fixture.session.getMessage({
              sessionID: fixture.assistant.sessionID,
              messageID: fixture.assistant.id,
            }),
          );
          expect(
            saved?.info.role === "assistant" && saved.info.request?.system,
          ).toContain("Analyze");
          observedSnapshot = true;
        },
      );
      return yield* Effect.gen(function* () {
        const processor = yield* Processor.create({
          assistantMessage: fixture.assistant,
          model,
        });
        expect(yield* processor.process(fixture.request)).toBeUndefined();
        const saved = yield* fixture.session.getMessage({
          sessionID: fixture.assistant.sessionID,
          messageID: fixture.assistant.id,
        });
        expect(observedSnapshot).toBe(true);
        expect(saved?.parts).toContainEqual(
          expect.objectContaining({ type: "text", text: "Hello" }),
        );
        expect(saved?.info).toMatchObject({
          tokens: { input: 1, output: 2 },
          finish: "stop",
        });
      }).pipe(Effect.provide(llmLayer(native)));
    }),
  );
});

test("real SDK tool waits for a committed Part and preserves its full outcome", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      let executions = 0;
      const result = yield* processor.process({
        ...fixture.request,
        tools: {
          echo: {
            description: "Echo",
            parameters: Schema.Struct({}),
            execute: (_, options) =>
              Effect.gen(function* () {
                const saved = yield* readToolPart(fixture, options.toolCallId);
                expect(saved).toMatchObject({ type: "tool", callID: "call" });
                executions++;
                return {
                  title: "Echo complete",
                  output: { type: "text" as const, value: "echo" },
                  metadata: { count: 1 },
                };
              }),
          },
        },
      });
      expect(result).toBeUndefined();
      expect(executions).toBe(1);
      const saved = yield* fixture.session.getMessage({
        sessionID: fixture.assistant.sessionID,
        messageID: fixture.assistant.id,
      });
      expect(saved?.parts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({
            status: "completed",
            title: "Echo complete",
            metadata: { count: 1 },
            output: { type: "text", value: "echo" },
          }),
        }),
      );
    }).pipe(Effect.provide(llmLayer(language(toolEvents)))),
  );
});

test("interrupting real LLM stops the callback and closes the durable tool", async () => {
  await run((fixture) =>
    Effect.gen(function* () {
      const processor = yield* Processor.create({
        assistantMessage: fixture.assistant,
        model,
      });
      const entered = yield* Deferred.make<void>();
      let cleaned = false;
      const running = yield* Effect.forkChild(
        processor.process({
          ...fixture.request,
          tools: {
            echo: {
              description: "Wait",
              parameters: Schema.Struct({}),
              execute: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Effect.never;
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      cleaned = true;
                    }),
                  ),
                ),
            },
          },
        }),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(running);
      const result = yield* Fiber.await(running);
      expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(
        true,
      );
      expect(cleaned).toBe(true);
      const saved = yield* fixture.session.getMessage({
        sessionID: fixture.assistant.sessionID,
        messageID: fixture.assistant.id,
      });
      expect(saved?.info).toMatchObject({
        error: { name: "MessageAbortedError" },
      });
      expect(saved?.parts).toContainEqual(
        expect.objectContaining({
          type: "tool",
          state: expect.objectContaining({ status: "error" }),
        }),
      );
    }).pipe(Effect.provide(llmLayer(language(toolEvents)))),
  );
});
