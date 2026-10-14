// Purpose: Verifies real AI SDK request behavior and Effect-owned request lifetimes.

import { CLAUDE_CODE, CODEX, TIER1 } from "@openchart/models/model-tiers";

import { setTimeout as delay } from "node:timers/promises";
import type {
  JSONValue,
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { AvailableModel } from "@openchart/models/model-provider";
import type { ProviderRequestContext } from "@openchart/models/native-provider";
import * as Providers from "@openchart/models/providers";
import type {
  ProviderTools,
  ProviderToolExecutionOptions,
} from "@openchart/models/provider-tools";
import { Models } from "@openchart/server/models";
import {
  modelTestDependencies,
  mockModels,
} from "@openchart/server/models/models.test-utils";
import { Tool } from "@openchart/server/agent/tool/tool";
import { simulateReadableStream } from "ai";
import {
  Cause,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Schema,
  SchemaGetter,
  Stream,
} from "effect";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { RequestFailed } from "./errors";
import { LLM } from "./llm";

const finish: LanguageModelV4StreamPart = {
  type: "finish",
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
};
const text: LanguageModelV4StreamPart[] = [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "Hello" },
  { type: "text-end", id: "text-1" },
  finish,
];

const realNativeProvider = Providers.nativeProvider;
/** Replaces native request options while keeping the provider's other behavior. */
function stubRequestOptions(
  requestOptions: (context: ProviderRequestContext) => Record<string, unknown>,
) {
  vi.spyOn(Providers, "nativeProvider").mockImplementation((providerID) => {
    const provider = realNativeProvider(providerID);
    return provider && { ...provider, requestOptions };
  });
}

function model(providerID = "openai") {
  return {
    id: "gpt-5-test",
    providerID,
    name: "Test",
    kind: "language",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: false,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
    },
    cost: {
      input: 1,
      output: 1,
      cache: { read: 0, write: 0 },
      contextTiers: [],
    },
    limit: { context: 200_000, output: 16_384 },
    availableVariants: ["high"],
  } satisfies AvailableModel;
}

function input<E = never, R = never>(
  overrides: Partial<LLM.StreamInput<E, R>> = {},
  selected: AvailableModel = model(),
): LLM.StreamInput<E, R> {
  return {
    cwd: "/workspace",
    model: selected,
    user: {
      id: "msg-1",
      model: { providerID: selected.providerID, modelID: selected.id },
    },
    sessionID: "session-1",
    agent: { name: "analyst", prompt: "Analyze carefully.", options: {} },
    system: ["Environment"],
    messages: [{ role: "user", content: "Hello" }],
    tools: {},
    ...overrides,
  };
}

function language(chunks = text) {
  const doStream = vi.fn<LanguageModelV4["doStream"]>(async () => ({
    stream: simulateReadableStream({ chunks }),
  }));
  const value: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Unexpected generate");
    },
    doStream,
  };
  const { service, dispose } = mockModels(model("openai"), value);
  const { list, getModel, getLanguage } = service;
  const models = Models.layer({
    runtimeDirectory: "/unused/providers",
    cacheDirectory: "/unused/models",
    fetchEnabled: false,
    userAgent: "test",
  }).pipe(Layer.provide(modelTestDependencies));
  const layer = LLM.layer.pipe(Layer.provideMerge(models));
  const collectEffect = <E, R>(request: LLM.StreamInput<E, R>) =>
    LLM.Service.use((llm) => Stream.runCollect(llm.stream(request))).pipe(
      Effect.provide(layer),
    );
  const collect = <E>(request: LLM.StreamInput<E>) =>
    Effect.runPromise(collectEffect(request));
  return {
    value,
    doStream,
    layer,
    collect,
    collectEffect,
    dispose,
    list,
    getModel,
    getLanguage,
  };
}

function toolLanguage(
  providerID: string,
  raw: string,
  options: ProviderToolExecutionOptions = { toolCallId: "call-1" },
) {
  const call = {
    type: "tool-call" as const,
    toolCallId: "call-1",
    toolName: "counter",
    input: raw,
  };
  const end = {
    ...finish,
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
  };
  const fixture = language([{ type: "stream-start", warnings: [] }, call, end]);
  if (providerID === "openai") return fixture;

  let tools: ProviderTools;
  stubRequestOptions(({ tools: definitions }) => {
    tools = definitions;
    return {};
  });
  fixture.doStream.mockImplementation(async () => {
    // Simulate restored application outcomes, including their MCP provenance.
    // Callback defects must still terminate the outer request.
    let result: unknown;
    let isError = false;
    try {
      result = await tools["counter"]!.execute(JSON.parse(raw), options);
    } catch (cause) {
      result = cause;
      isError = true;
    }
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            ...call,
            providerExecuted: true,
            providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
          },
          {
            type: "tool-result",
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            result: result as NonNullable<JSONValue>,
            providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
            isError,
          },
          end,
        ] satisfies LanguageModelV4StreamPart[],
      }),
    };
  });
  return fixture;
}

afterEach(() => vi.restoreAllMocks());

test("allows callers to replace LLM through a Layer", async () => {
  const { layer } = language();
  const request = input();
  const event = {
    type: "text-delta" as const,
    id: "replacement",
    text: "Replaced",
  };
  const stream = vi.fn(() => Stream.make(event));
  const events = await Effect.runPromise(
    LLM.Service.use((llm) => Stream.runCollect(llm.stream(request))).pipe(
      Effect.provideService(LLM.Service, { stream }),
      Effect.provide(layer),
    ),
  );
  expect(events).toEqual([event]);
  expect(stream).toHaveBeenCalledExactlyOnceWith(request);
});

describe.each(["openai", CODEX, CLAUDE_CODE])(
  "%s Effect tool boundary",
  (providerID) => {
    test("resolves tool and snapshot requirements from the consuming request", async () => {
      class RequestValue extends Context.Service<
        RequestValue,
        { value: string }
      >()("RequestValue") {}
      const fixture = toolLanguage(providerID, '{"count":"3"}');
      const snapshots: string[] = [];
      const request = input(
        {
          tools: {
            counter: {
              description: "Read the request value",
              parameters: Schema.Struct({ count: Schema.String }),
              execute: () =>
                RequestValue.use((service) =>
                  Effect.succeed({
                    title: "Request value",
                    metadata: {},
                    output: { type: "text" as const, value: service.value },
                  }),
                ),
            },
          },
          recordRequestSnapshot: () =>
            RequestValue.use((service) =>
              Effect.sync(() => {
                snapshots.push(service.value);
              }),
            ),
        },
        model(providerID),
      );
      const stream = LLM.Service.use((llm) =>
        Stream.runCollect(llm.stream(request)),
      );
      expectTypeOf<Effect.Services<typeof stream>>().toEqualTypeOf<
        LLM.Service | Models.Service | RequestValue
      >();
      const events = await Effect.runPromise(
        stream.pipe(
          Effect.provide(fixture.layer),
          Effect.provideService(RequestValue, { value: "request-local" }),
        ),
      );
      expect(snapshots).toEqual(["request-local"]);
      expect(
        events.find((event) => event.type === "tool-result")?.output,
      ).toMatchObject({
        output: { type: "text", value: "request-local" },
      });
    });

    test.each([
      "3",
      "0",
      ...(providerID === "openai" ? ["double-encoded"] : []),
    ])(
      "decodes %s once inside Tool and preserves original stream input",
      async (count) => {
        const raw = { count: count === "double-encoded" ? "3" : count };
        const encoded = JSON.stringify(raw);
        const fixture = toolLanguage(
          providerID,
          count === "double-encoded" ? JSON.stringify(encoded) : encoded,
        );
        let conversions = 0;
        const parameters = Schema.Struct({
          count: Schema.String.pipe(
            Schema.decodeTo(
              Schema.Number.check(Schema.makeFilter((value) => value > 0)),
              {
                decode: SchemaGetter.transform((value) => {
                  conversions++;
                  return Number(value);
                }),
                encode: SchemaGetter.transform(String),
              },
            ),
          ),
        });
        const outcome = {
          title: "Count",
          metadata: {},
          output: { type: "json" as const, value: { count: 3 } },
        };
        const implementation = vi.fn((args: typeof parameters.Type) => {
          expect(args).toEqual({ count: 3 });
          return Effect.succeed(outcome);
        });
        const definition = await Effect.runPromise(
          Tool.define(
            "counter",
            Effect.succeed({
              description: "Count",
              parameters,
              execute: implementation,
            }),
          ).pipe(Effect.flatMap(Tool.init)),
        );
        const events = await fixture.collect(
          input(
            {
              tools: {
                counter: {
                  ...definition,
                  execute: (args, options) =>
                    definition.execute(args, {
                      rootRunID: "agr_test",
                      sessionID: "session-1",
                      messageID: "assistant-1",
                      callID: options.toolCallId,
                      agent: "analyst",
                      messages: [],
                      metadata: () => Effect.void,
                      ask: () => Effect.void,
                    }),
                },
              },
            },
            model(providerID),
          ),
        );
        expect(conversions).toBe(1);
        expect(
          events.find((event) => event.type === "tool-call"),
        ).toMatchObject({
          input: raw,
        });
        if (raw.count === "3") {
          expect(implementation).toHaveBeenCalledTimes(1);
          const result = events.find((event) => event.type === "tool-result");
          expect(result?.output).toBe(outcome);
        } else {
          expect(implementation).not.toHaveBeenCalled();
          if (providerID === "openai")
            expect(
              events.find((event) => event.type === "tool-call")?.invalid,
            ).not.toBe(true);
          expect(
            events.find((event) => event.type === "tool-error")?.error,
          ).toMatchObject({
            _tag: "Tool.InvalidArgumentsError",
          });
        }
      },
    );

    test.each(["failure", "defect", "interruption"])(
      "preserves callback %s semantics through the SDK",
      async (kind) => {
        const fixture = toolLanguage(providerID, '{"count":"3"}');
        const cause = new Error("Tool failed");
        const effect =
          kind === "failure"
            ? Effect.fail(cause)
            : kind === "defect"
              ? Effect.die(cause)
              : Effect.interrupt;
        const exit = await Effect.runPromiseExit(
          fixture
            .collectEffect(
              input(
                {
                  tools: {
                    counter: {
                      description: "Count",
                      parameters: Schema.Struct({ count: Schema.String }),
                      execute: () => effect,
                    },
                  },
                },
                model(providerID),
              ),
            )
            .pipe(Effect.timeout("2 seconds")),
        );
        if (kind !== "defect") {
          expect(Exit.isSuccess(exit)).toBe(true);
          if (Exit.isSuccess(exit)) {
            const error = exit.value.find(
              (event) => event.type === "tool-error",
            )?.error;
            if (kind === "failure") expect(error).toBe(cause);
            else expect(error).toBeDefined();
          }
        } else {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasFails(exit.cause)).toBe(false);
            expect(Cause.hasDies(exit.cause)).toBe(true);
            expect(Cause.squash(exit.cause)).toBe(cause);
          }
        }
        expect(fixture.doStream.mock.calls[0]?.[0].abortSignal?.aborted).toBe(
          true,
        );
      },
    );

    test("request interruption cancels native tool work and waits for cleanup", async () => {
      const fixture = toolLanguage(providerID, '{"count":"3"}');
      const started = Deferred.makeUnsafe<AbortSignal>();
      const nativeStopped = vi.fn();
      const released = vi.fn();
      let options: LLM.ToolExecutionOptions | undefined;
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* fixture
            .collectEffect(
              input(
                {
                  tools: {
                    counter: {
                      description: "Count",
                      parameters: Schema.Struct({ count: Schema.String }),
                      execute: (_args, call) => {
                        options = call;
                        return Effect.tryPromise((signal) => {
                          const pending = delay(60_000, undefined, {
                            signal,
                            ref: false,
                          }).finally(nativeStopped);
                          Deferred.doneUnsafe(started, Effect.succeed(signal));
                          return pending;
                        }).pipe(
                          Effect.as({
                            title: "Wait",
                            metadata: {},
                            output: {
                              type: "text" as const,
                              value: "Finished",
                            },
                          }),
                          Effect.ensuring(
                            Effect.sleep("10 millis").pipe(
                              Effect.andThen(Effect.sync(released)),
                            ),
                          ),
                        );
                      },
                    },
                  },
                },
                model(providerID),
              ),
            )
            .pipe(Effect.forkChild);
          const signal = yield* Deferred.await(started);
          expect(options?.toolCallId).toBe("call-1");
          yield* Fiber.interrupt(fiber);
          expect(signal.aborted).toBe(true);
          expect(nativeStopped).toHaveBeenCalledTimes(1);
          expect(released).toHaveBeenCalledTimes(1);
        }).pipe(Effect.timeout("2 seconds")),
      );
    });
  },
);

test.each([CODEX, CLAUDE_CODE])(
  "%s single-call cancellation stops native work and lets the SDK finish the request",
  async (providerID) => {
    const controller = new AbortController();
    const fixture = toolLanguage(providerID, '{"count":"3"}', {
      toolCallId: "call-1",
      abortSignal: controller.signal,
    });
    const started = Deferred.makeUnsafe<AbortSignal>();
    const nativeStopped = vi.fn();
    const released = vi.fn();
    const request = input(
      {
        tools: {
          counter: {
            description: "Count",
            parameters: Schema.Struct({ count: Schema.String }),
            execute: () =>
              Effect.tryPromise((signal) => {
                const pending = delay(60_000, undefined, {
                  signal,
                  ref: false,
                }).finally(nativeStopped);
                Deferred.doneUnsafe(started, Effect.succeed(signal));
                return pending;
              }).pipe(
                Effect.as({
                  title: "Wait",
                  metadata: {},
                  output: { type: "text" as const, value: "Finished" },
                }),
                Effect.ensuring(Effect.sync(released)),
              ),
          },
        },
      },
      model(providerID),
    );
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* fixture
          .collectEffect(request)
          .pipe(Effect.forkChild);
        const signal = yield* Deferred.await(started);
        controller.abort();
        const exit = yield* Fiber.await(fiber);
        expect(signal.aborted).toBe(true);
        return exit;
      }).pipe(Effect.timeout("2 seconds")),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit))
      expect(exit.value.some((event) => event.type === "tool-error")).toBe(
        true,
      );
    expect(released).toHaveBeenCalledTimes(1);
    expect(nativeStopped).toHaveBeenCalledTimes(1);
    expect(fixture.doStream.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
  },
);

test("rejects an aborted native invocation before entering the caller", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = toolLanguage(CODEX, '{"count":"3"}', {
    toolCallId: "call-1",
    abortSignal: controller.signal,
  });
  const execute = vi.fn(() =>
    Effect.succeed({
      title: "Done",
      metadata: {},
      output: { type: "text" as const, value: "Done" },
    }),
  );
  const exit = await Effect.runPromiseExit(
    fixture.collectEffect(
      input(
        {
          tools: {
            counter: {
              description: "Count",
              parameters: Schema.Struct({ count: Schema.String }),
              execute,
            },
          },
        },
        model(CODEX),
      ),
    ),
  );
  expect(execute).not.toHaveBeenCalled();
  expect(Exit.isSuccess(exit)).toBe(true);
  if (Exit.isSuccess(exit))
    expect(exit.value.some((event) => event.type === "tool-error")).toBe(true);
});

test.each(["failure", "defect", "interruption"])(
  "preserves permission %s even when the provider catches the rejection",
  async (kind) => {
    const fixture = language();
    const cause = new Error("Permission callback failed");
    let rejection: unknown;
    stubRequestOptions(({ askPermission }) => {
      fixture.doStream.mockImplementation(async () => {
        try {
          await askPermission!({
            permission: "read",
            patterns: ["*"],
            metadata: {},
            always: [],
          });
        } catch (error) {
          rejection = error;
        }
        return { stream: simulateReadableStream({ chunks: text }) };
      });
      return {};
    });
    const exit = await Effect.runPromiseExit(
      fixture.collectEffect(
        input(
          {
            askPermission: () =>
              kind === "failure"
                ? Effect.fail(cause)
                : kind === "defect"
                  ? Effect.die(cause)
                  : Effect.interrupt,
          },
          model(CLAUDE_CODE),
        ),
      ),
    );
    if (kind !== "defect") {
      expect(Exit.isSuccess(exit)).toBe(true);
      if (kind === "failure") expect(rejection).toBe(cause);
      else expect(rejection).toBeDefined();
      if (Exit.isSuccess(exit))
        expect(exit.value).toContainEqual(
          expect.objectContaining({ type: "text-delta", text: "Hello" }),
        );
    } else {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(cause);
      }
    }
    expect(fixture.doStream.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
  },
);

describe("scoped request lifecycle", () => {
  test("is lazy, fresh per consumption, records preparation first, and aborts completed calls", async () => {
    const fixture = language();
    const prepared = vi.fn();
    await Effect.runPromise(
      Effect.gen(function* () {
        const llm = yield* LLM.Service;
        const stream = llm.stream(
          input({ recordRequestSnapshot: () => Effect.sync(prepared) }),
        );
        expect(fixture.getModel).not.toHaveBeenCalled();
        expect(fixture.doStream).not.toHaveBeenCalled();
        expect(prepared).not.toHaveBeenCalled();
        yield* Stream.runCollect(stream);
        expect(fixture.doStream.mock.calls[0]?.[0].abortSignal?.aborted).toBe(
          true,
        );
        expect(fixture.dispose).not.toHaveBeenCalled();
        yield* Stream.runCollect(stream);
        expect(fixture.doStream.mock.calls[1]?.[0].abortSignal?.aborted).toBe(
          true,
        );
        expect(fixture.dispose).not.toHaveBeenCalled();
      }).pipe(Effect.provide(fixture.layer)),
    );
    expect(prepared).toHaveBeenCalledTimes(2);
    expect(fixture.doStream).toHaveBeenCalledTimes(2);
    expect(prepared.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.doStream.mock.invocationCallOrder[0]!,
    );
    const signals = fixture.doStream.mock.calls.map(
      ([request]) => request.abortSignal,
    );
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });

  test.each(["openai", CODEX, CLAUDE_CODE])(
    "%s preparation failure stays typed and unchanged and prevents provider I/O",
    async (providerID) => {
      const fixture = language();
      const cause = { _tag: "SnapshotWriteFailed" as const };
      const program = fixture.collectEffect(
        input(
          { recordRequestSnapshot: () => Effect.fail(cause) },
          model(providerID),
        ),
      );
      expectTypeOf<Effect.Error<typeof program>>().toEqualTypeOf<
        LLM.LlmError | typeof cause
      >();
      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(cause);
      }
      expect(fixture.doStream).not.toHaveBeenCalled();
    },
  );

  test.each(["openai", CODEX, CLAUDE_CODE])(
    "interrupting an idle %s consumer aborts its request",
    async (providerID) => {
      const fixture = language();
      const started = Deferred.makeUnsafe<void>();
      let signal: AbortSignal | undefined;
      fixture.doStream.mockImplementation(async (options) => {
        signal = options.abortSignal;
        return {
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              signal?.addEventListener("abort", () => controller.close(), {
                once: true,
              });
              Deferred.doneUnsafe(started, Effect.void);
            },
          }),
        };
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const llm = yield* LLM.Service;
          const fiber = yield* Stream.runDrain(
            llm.stream(input({}, model(providerID))),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          expect(signal?.aborted).toBe(true);
        }).pipe(Effect.provide(fixture.layer), Effect.timeout("2 seconds")),
      );
    },
  );

  test("provider error events fail with their original cause", async () => {
    const cause = new Error("Provider unavailable");
    const fixture = language([
      { type: "stream-start", warnings: [] },
      { type: "error", error: cause },
    ]);
    const exit = await Effect.runPromiseExit(fixture.collectEffect(input()));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.squash(exit.cause);
      expect(failure).toBeInstanceOf(RequestFailed);
      expect(failure).toMatchObject({ cause });
      expect(Cause.hasDies(exit.cause)).toBe(false);
    }
    expect(fixture.doStream.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
  });
});

describe("request policy", () => {
  test("keeps prompts, explicit options, sampling, headers and a detached snapshot", async () => {
    const fixture = language();
    const metadata = model();
    const snapshot = vi.fn();
    const events = await fixture.collect(
      input(
        {
          user: {
            id: "msg-1",
            model: {
              providerID: "openai",
              modelID: metadata.id,
            },
          },
          agent: {
            name: "analyst",
            prompt: "Analyze carefully.",
            temperature: 0.3,
            topP: 0.8,
            options: {
              reasoningEffort: "high",
              nested: { agent: true, value: "agent" },
              promptCacheKey: "configured-cache-key",
              doNotSpillLongToolOutputToSandbox: true,
            },
          },
          headers: { "X-Call": "yes" },
          tools: {
            search: {
              description: "Search",
              parameters: Schema.Struct({ query: Schema.String }),
              execute: () =>
                Effect.succeed({
                  title: "Search",
                  metadata: {},
                  output: { type: "text", value: "Found" },
                }),
            },
          },
          recordRequestSnapshot: (request) =>
            Effect.sync(() => snapshot(request)),
        },
        metadata,
      ),
    );
    expect(events.find((event) => event.type === "text-delta")).toMatchObject({
      text: "Hello",
    });
    const request = fixture.doStream.mock.calls[0]![0];
    expect(request).toMatchObject({
      temperature: 0.3,
      topP: 0.8,
      maxOutputTokens: 16_384,
      headers: { "X-Call": "yes" },
      providerOptions: {
        openai: {
          reasoningEffort: "high",
          nested: { agent: true, value: "agent" },
          promptCacheKey: "configured-cache-key",
        },
      },
    });
    expect(request.providerOptions?.["openai"]).not.toHaveProperty(
      "doNotSpillLongToolOutputToSandbox",
    );
    expect(request.prompt[0]).toMatchObject({
      role: "system",
      content: "Analyze carefully.\nEnvironment",
    });
    expect(snapshot.mock.calls[0]![0]).toMatchObject({
      system: ["Analyze carefully.\nEnvironment"],
      tools: [{ id: "search", description: "Search" }],
    });
    expect(fixture.getModel).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(metadata).not.toHaveProperty("variant");
    const sdkTool = request.tools?.[0];
    if (sdkTool?.type !== "function") throw new Error("Expected search tool");
    Object.assign(sdkTool.inputSchema.properties!["query"]!, {
      type: "number",
    });
    expect(snapshot.mock.calls[0]![0]).toMatchObject({
      tools: [
        {
          id: "search",
          inputSchema: { properties: { query: { type: "string" } } },
        },
      ],
    });
  });

  test("uses the supplied native snapshot for tier input without rediscovery", async () => {
    const fixture = language();
    const selected = {
      ...model("anthropic"),
      id: "haiku",
      tier: 1,
      availableVariants: [],
      limit: { context: 8192, output: 1024 },
    };
    await fixture.collect(
      input({
        model: selected,
        user: {
          id: "msg-1",
          model: {
            providerID: selected.providerID,
            modelID: TIER1,
          },
        },
        agent: { ...input().agent, options: { marker: true } },
        tools: {
          search: {
            description: "Search",
            parameters: Schema.Struct({ query: Schema.String }),
            execute: () =>
              Effect.succeed({
                title: "Search",
                metadata: {},
                output: { type: "text", value: "Found" },
              }),
          },
        },
      }),
    );
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.getModel).not.toHaveBeenCalled();
    expect(fixture.getLanguage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "haiku" }),
    );
    const request = fixture.doStream.mock.calls[0]![0];
    expect(request).toMatchObject({
      maxOutputTokens: 1024,
      headers: {},
      providerOptions: { anthropic: { marker: true } },
    });
    expect(request.reasoning).toBeUndefined();
    expect(request.tools).toEqual([
      expect.objectContaining({ name: "search" }),
    ]);
    expect(request.providerOptions?.["codex-app-server"]).toBeUndefined();
  });

  test("preserves explicit provider reasoning overrides for tier 1", async () => {
    const fixture = language();
    const selected = { ...model(), tier: 1, id: "gpt-5-tier-one" };
    await fixture.collect(
      input({
        model: selected,
        agent: {
          ...input().agent,
          options: { reasoningEffort: "high", store: true },
        },
      }),
    );
    const request = fixture.doStream.mock.calls[0]![0];
    expect(request.reasoning).toBeUndefined();
    expect(request.providerOptions?.["openai"]).toMatchObject({
      store: true,
      reasoningEffort: "high",
    });
  });

  test.each(["gemini-2.5-flash", "gemini-3.1-pro", "gemini-3.5-flash"])(
    "%s uses provider sampling defaults",
    async (id) => {
      const fixture = language();
      const metadata = model("google");
      metadata.id = id;
      await fixture.collect(input({}, metadata));
      const request = fixture.doStream.mock.calls[0]![0];
      expect(request.temperature).toBeUndefined();
      expect(request.topP).toBeUndefined();
      expect(request.topK).toBeUndefined();
    },
  );

  test.each([0, 32_000, 64_000])(
    "uses discovered output limit %s without injecting Claude caching",
    async (output) => {
      const fixture = language();
      const metadata = model("anthropic");
      metadata.limit.output = output;
      metadata.id = "claude-opus-4-1";
      await fixture.collect(
        input(
          {
            agent: {
              ...input().agent,
              options: { thinking: { type: "enabled", budgetTokens: 16_000 } },
            },
            tools: {
              search: {
                description: "Search",
                parameters: Schema.Struct({ query: Schema.String }),
                execute: () =>
                  Effect.succeed({
                    title: "Search",
                    metadata: {},
                    output: { type: "text", value: "Found" },
                  }),
              },
            },
          },
          metadata,
        ),
      );
      const request = fixture.doStream.mock.calls[0]![0];
      expect(request.maxOutputTokens).toBe(32_000);
      expect(request.providerOptions?.["anthropic"]).toEqual({
        thinking: { type: "enabled", budgetTokens: 16_000 },
      });
      expect(
        request.prompt.every(
          (message) => message.providerOptions === undefined,
        ),
      ).toBe(true);
      expect(request.tools?.[0]).not.toHaveProperty(
        "providerOptions.anthropic.cacheControl",
      );
    },
  );

  test("preserves explicit request-level caching options", async () => {
    const fixture = language();
    const metadata = model("anthropic");
    metadata.id = "claude-sonnet-4-6";
    await fixture.collect(
      input(
        {
          agent: {
            ...input().agent,
            options: { cacheControl: { type: "ephemeral", ttl: "1h" } },
          },
        },
        metadata,
      ),
    );
    expect(
      fixture.doStream.mock.calls[0]?.[0].providerOptions?.["anthropic"],
    ).toMatchObject({
      cacheControl: { type: "ephemeral", ttl: "1h" },
    });
  });

  test("accepts only public model metadata with unknown limits", async () => {
    const fixture = language();
    const metadata = AvailableModel.parse({
      kind: "language",
      providerID: "openai",
      id: "gpt-5-test",
      name: "Test",
      capabilities: { input: {}, output: {} },
    });
    await fixture.collect(input({}, metadata));
    expect(fixture.doStream.mock.calls[0]?.[0].maxOutputTokens).toBe(32_000);
  });

  test.each([
    { availableVariants: undefined },
    { availableVariants: [] },
    { availableVariants: ["low"] },
  ])(
    "rejects an unavailable selected variant before provider I/O (%j)",
    async ({ availableVariants }) => {
      const fixture = language();
      await expect(
        fixture.collect(
          input(
            {
              user: {
                id: "msg-1",
                model: {
                  providerID: "openai",
                  modelID: "gpt-5-test",
                  selectedVariant: "high",
                },
              },
            },
            { ...model(), availableVariants },
          ),
        ),
      ).rejects.toMatchObject({ _tag: "LLM.VariantNotFound" });
      expect(fixture.getLanguage).not.toHaveBeenCalled();
      expect(fixture.doStream).not.toHaveBeenCalled();
    },
  );

  test("executes a local tool once, preserves its exact outcome, and does not sample continuation", async () => {
    const fixture = language([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "research",
        input: '{"query":"AAPL"}',
      },
      { ...finish, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
    ]);
    const output = {
      title: "Research",
      metadata: { source: "test" },
      output: { type: "json" as const, value: { symbol: "AAPL" } },
    };
    const execute = vi.fn(() => Effect.succeed(output));
    const events = await fixture.collect(
      input({
        tools: {
          research: {
            description: "Research",
            parameters: Schema.Struct({ query: Schema.String }),
            execute,
          },
        },
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]).toBeDefined();
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({
      toolName: "research",
      output,
    });
    expect(fixture.doStream).toHaveBeenCalledTimes(1);
  });

  test.each([
    [
      "repairs valid double-encoded input",
      JSON.stringify(JSON.stringify({ summary: "Result" })),
      true,
    ],
    [
      "rejects invalid input after repair",
      JSON.stringify(JSON.stringify({ summary: 42 })),
      false,
    ],
    [
      "rejects an ordinary semantic error",
      JSON.stringify({ summary: 42 }),
      false,
    ],
  ])("%s", async (_name, raw, valid) => {
    const fixture = language([
      { type: "stream-start", warnings: [] },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "record",
        input: raw,
      },
      { ...finish, finishReason: { unified: "tool-calls", raw: "tool-calls" } },
    ]);
    const execute = vi.fn(() =>
      Effect.succeed({
        title: "Done",
        metadata: {},
        output: { type: "text" as const, value: "Done" },
      }),
    );
    const events = await fixture.collect(
      input({
        tools: {
          record: {
            description: "Record",
            parameters: Schema.Struct({ summary: Schema.String }),
            execute,
          },
        },
      }),
    );
    expect(execute).toHaveBeenCalledTimes(valid ? 1 : 0);
    if (!valid)
      expect(events.find((event) => event.type === "tool-call")).toMatchObject({
        invalid: true,
      });
  });

  test.each([
    ["Reply exactly OK and nothing else", "none"],
    ["Research AAPL", "auto"],
  ])("selects tool choice for %s", async (content, choice) => {
    const fixture = language();
    await fixture.collect(
      input({
        messages: [{ role: "user", content }],
        tools: {
          search: {
            description: "Search",
            parameters: Schema.Struct({ query: Schema.String }),
            execute: () =>
              Effect.succeed({
                title: "Search",
                metadata: {},
                output: { type: "text", value: "Found" },
              }),
          },
        },
      }),
    );
    const request = fixture.doStream.mock.calls[0]![0];
    expect(request.toolChoice).toEqual({ type: choice });
    expect(request.tools).toEqual([
      expect.objectContaining({ name: "search" }),
    ]);
  });
});

describe("provider-managed requests", () => {
  test.each([CODEX, CLAUDE_CODE])(
    "reads the current permission setting for each %s request",
    async (providerID) => {
      const fixture = language();
      let snapshot = ConfigProvider.fromUnknown({});
      const source = ConfigProvider.make((path) => snapshot.load(path));
      const collect = () =>
        Effect.runPromise(
          fixture
            .collectEffect(input({}, model(providerID)))
            .pipe(Effect.provideService(ConfigProvider.ConfigProvider, source)),
        );
      for (const mode of [undefined, "ask", "auto", "full-access"] as const) {
        snapshot = ConfigProvider.fromUnknown(
          mode ? { models: { permissionMode: mode } } : {},
        );
        await collect();
        const options = fixture.doStream.mock.calls.at(-1)![0].providerOptions;
        if (providerID === CODEX) {
          expect(options?.["codex-app-server"]).toMatchObject({
            approvalPolicy:
              mode === "ask" || mode === "auto" ? "on-request" : "never",
            sandbox:
              mode === "ask" || mode === "auto"
                ? "workspace-write"
                : "danger-full-access",
            approvalsReviewer: mode === "auto" ? "auto_review" : "user",
          });
        } else {
          expect(options?.[CLAUDE_CODE]).toMatchObject({
            permissionMode:
              mode === "ask"
                ? "default"
                : mode === "auto"
                  ? "auto"
                  : "bypassPermissions",
            allowDangerouslySkipPermissions: mode !== "ask" && mode !== "auto",
            sandbox: { enabled: mode === "ask" || mode === "auto" },
          });
        }
      }
      const calls = fixture.doStream.mock.calls.length;
      snapshot = ConfigProvider.fromUnknown({
        models: { permissionMode: "invalid" },
      });
      await expect(collect()).rejects.toMatchObject({
        _tag: "Models.ConfigurationUnavailable",
      });
      expect(fixture.doStream).toHaveBeenCalledTimes(calls);
    },
  );

  test.each([CODEX, CLAUDE_CODE])(
    "full access preserves OpenChart tool refusal for %s",
    async (providerID) => {
      const fixture = toolLanguage(providerID, "{}");
      const blocked = new Error("Blocked by OpenChart tool policy");
      const execute = vi.fn(() => Effect.fail(blocked));
      const events = await fixture.collect(
        input(
          {
            tools: {
              counter: {
                description: "A blocked application tool",
                parameters: Schema.Struct({}),
                execute,
              },
            },
          },
          model(providerID),
        ),
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(events.find((event) => event.type === "tool-error")).toMatchObject(
        { error: blocked },
      );
    },
  );

  test("normalizes child steps after the SDK and preserves scoped text", async () => {
    const metadata = { openchart: { delegateCallId: "proxy-1" } };
    const fixture = language([
      { type: "stream-start", warnings: [] },
      {
        type: "custom",
        kind: "openchart.delegate-start-step",
        providerMetadata: metadata,
      },
      { type: "text-start", id: "child-text", providerMetadata: metadata },
      {
        type: "text-delta",
        id: "child-text",
        delta: "Child answer",
        providerMetadata: metadata,
      },
      { type: "text-end", id: "child-text", providerMetadata: metadata },
      {
        type: "custom",
        kind: "openchart.delegate-finish-step",
        providerMetadata: {
          openchart: {
            ...metadata.openchart,
            finishDelegate: {
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                inputTokenDetails: {
                  noCacheTokens: 1,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
                outputTokens: 1,
                outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
                totalTokens: 2,
              },
            },
          },
        },
      },
      finish,
    ]);
    stubRequestOptions(() => ({}));
    const events = await fixture.collect(input({}, model(CLAUDE_CODE)));
    const steps = events.filter(
      (event) =>
        (event.type === "start-step" || event.type === "finish-step") &&
        event.providerMetadata?.openchart?.delegateCallId === "proxy-1",
    );
    expect(steps.map((event) => event.type)).toEqual([
      "start-step",
      "finish-step",
    ]);
    expect(events.find((event) => event.type === "text-delta")).toMatchObject({
      text: "Child answer",
      providerMetadata: metadata,
    });
    expect(fixture.doStream).toHaveBeenCalledTimes(1);
    const request = fixture.doStream.mock.calls[0]![0];
    expect(request.tools).toBeUndefined();
    expect(request.temperature).toBeUndefined();
    expect(request.maxOutputTokens).toBeUndefined();
  });

  test("derives MCP schemas and enforces application validation inside the request scope", async () => {
    class PermissionCheck extends Context.Service<
      PermissionCheck,
      { check: () => void }
    >()("PermissionCheck") {}
    const fixture = language();
    let tools: ProviderTools | undefined;
    let askPermission: ProviderRequestContext["askPermission"] | undefined;
    const check = vi.fn();
    const ask = vi.fn(() =>
      PermissionCheck.use((service) => Effect.sync(service.check)),
    );
    stubRequestOptions(({ tools: definitions, askPermission: callback }) => {
      tools = definitions;
      askPermission = callback;
      return {};
    });
    const outcome = {
      output: { type: "json" as const, value: { count: 1 } },
      title: "Done",
      metadata: {},
    };
    const execute = vi.fn(() => Effect.succeed(outcome));
    fixture.doStream.mockImplementation(async () => {
      const definition = tools!["search"]!;
      expect(definition.inputSchema.safeParse({ query: "AAPL" }).success).toBe(
        true,
      );
      expect(definition.inputSchema.safeParse({ query: 4 }).success).toBe(
        false,
      );
      await expect(
        definition.execute({ query: "MSFT" }, { toolCallId: "call-0" }),
      ).rejects.toMatchObject({ _tag: "LLM.InvalidToolArguments" });
      expect(execute).not.toHaveBeenCalled();
      const result = await definition.execute(
        { query: "AAPL" },
        { toolCallId: "call-1" },
      );
      expect(result).toBe(outcome);
      expect(definition.toModelOutput(result)).toEqual({ count: 1 });
      await askPermission!({
        permission: "read",
        patterns: ["AAPL"],
        metadata: {},
        always: [],
      });
      return { stream: simulateReadableStream({ chunks: text }) };
    });
    await Effect.runPromise(
      fixture
        .collectEffect(
          input(
            {
              askPermission: ask,
              tools: {
                search: {
                  description: "Search",
                  execute,
                  parameters: Schema.Struct({ query: Schema.String }).check(
                    Schema.makeFilter((value) => value.query.startsWith("A")),
                  ),
                },
              },
            },
            model(CLAUDE_CODE),
          ),
        )
        .pipe(Effect.provideService(PermissionCheck, { check })),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith({
      permission: "read",
      patterns: ["AAPL"],
      metadata: {},
      always: [],
    });
    await expect(
      tools!["search"]!.execute({ query: "AAPL" }, { toolCallId: "call-2" }),
    ).rejects.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("malformed delegate markers remain defects", async () => {
    const fixture = language([
      { type: "stream-start", warnings: [] },
      { type: "custom", kind: "openchart.delegate-start-step" },
      finish,
    ]);
    stubRequestOptions(() => ({}));
    const exit = await Effect.runPromiseExit(
      fixture.collectEffect(input({}, model(CLAUDE_CODE))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(fixture.doStream.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
  });
});

test("native question cancellation releases its host wait while the model request can continue", async () => {
  const fixture = language();
  const cancelled = new AbortController();
  let cleaned = false;
  let rejection: unknown;
  stubRequestOptions(({ askQuestion }) => {
    fixture.doStream.mockImplementation(async () => {
      const question = askQuestion!(
        { questions: [] },
        { signal: cancelled.signal },
      );
      await vi.waitFor(() => expect(started).toBe(true));
      cancelled.abort();
      try {
        await question;
      } catch (error) {
        rejection = error;
      }
      return { stream: simulateReadableStream({ chunks: text }) };
    });
    return {};
  });
  let started = false;
  const events = await Effect.runPromise(
    fixture.collectEffect(
      input(
        {
          askQuestion: () =>
            Effect.sync(() => {
              started = true;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true;
                }),
              ),
            ),
        },
        model(CODEX),
      ),
    ),
  );
  expect(rejection).toBeDefined();
  expect(cleaned).toBe(true);
  expect(events).toContainEqual(
    expect.objectContaining({ type: "text-delta", text: "Hello" }),
  );
});
