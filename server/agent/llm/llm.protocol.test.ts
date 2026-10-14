// Purpose: Verifies nested delegate routing through Models, AI SDK, and the Effect LLM boundary.

import { CLAUDE_CODE, CODEX } from "@openchart/models/model-tiers";

import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { AvailableModel } from "@openchart/models/model-provider";
import { Models } from "@openchart/server/models";
import {
  modelTestDependencies,
  mockModels,
} from "@openchart/server/models/models.test-utils";
import { simulateReadableStream } from "ai";
import { Effect, Layer, Stream } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import { LLM } from "./llm";

const usage = {
  inputTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
  totalTokens: 0,
};
const ownedBy = (id: string): SharedV4ProviderMetadata => ({
  openchart: { delegateCallId: id },
});
function proxy(id: string, parent: string | null): LanguageModelV4StreamPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "Agent",
    input: "{}",
    providerExecuted: true,
    providerMetadata: {
      openchart: {
        ...(parent === null ? {} : { delegateCallId: parent }),
        openDelegate: { description: id, prompt: id, agent: "research" },
      },
    },
  };
}
function start(id: string): LanguageModelV4StreamPart {
  return {
    type: "custom",
    kind: "openchart.delegate-start-step",
    providerMetadata: ownedBy(id),
  };
}
function end(id: string, failed = false): LanguageModelV4StreamPart {
  return {
    type: "custom",
    kind: "openchart.delegate-finish-step",
    providerMetadata: {
      openchart: {
        ...ownedBy(id)["openchart"],
        finishDelegate: {
          finishReason: failed ? "error" : "stop",
          usage,
        },
      },
    },
  };
}
function content(id: string, parent?: string): LanguageModelV4StreamPart[] {
  const providerMetadata = parent ? ownedBy(parent) : undefined;
  return [
    { type: "text-start", id, providerMetadata },
    { type: "text-delta", id, delta: id, providerMetadata },
    { type: "text-end", id, providerMetadata },
  ];
}
function result(
  id: string,
  parent?: string,
  failed = false,
): LanguageModelV4StreamPart {
  return {
    type: "tool-result",
    toolCallId: id,
    toolName: "Agent",
    result: "PROXY RESULT IS NOT CHILD TEXT",
    isError: failed,
    providerMetadata: parent ? ownedBy(parent) : undefined,
  };
}

afterEach(() => vi.restoreAllMocks());

test.each([
  [CODEX, false],
  [CODEX, true],
  [CLAUDE_CODE, false],
  [CLAUDE_CODE, true],
] as const)(
  "%s preserves complete nested delegate ordering (child failure: %s)",
  async (providerID, failed) => {
    const chunks: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      proxy("A", null),
      start("A"),
      ...content("A-before", "A"),
      proxy("B", "A"),
      start("B"),
      ...content("B-body", "B"),
      end("B", failed),
      result("B", "A", failed),
      ...content("A-after", "A"),
      end("A"),
      result("A"),
      ...content("root-body"),
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
      },
    ];
    const doStream = vi.fn<LanguageModelV4["doStream"]>(async () => ({
      stream: simulateReadableStream({ chunks }),
    }));
    const language: LanguageModelV4 = {
      specificationVersion: "v4",
      provider: providerID,
      modelId: "native-alias",
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream,
    };
    const model = AvailableModel.parse({
      kind: "language",
      providerID,
      id: "native-alias",
      name: "Native",
      capabilities: { input: {}, output: {} },
    });
    const { dispose } = mockModels(model, language);
    const models = Models.layer({
      runtimeDirectory: "/unused/providers",
      cacheDirectory: "/unused/models",
      fetchEnabled: false,
      userAgent: "test",
    }).pipe(Layer.provide(modelTestDependencies));
    const events = await Effect.runPromise(
      LLM.Service.use((llm) =>
        Stream.runCollect(
          llm.stream({
            model,
            cwd: "/workspace",
            sessionID: "session",
            user: {
              id: "user-message",
              model: { providerID, modelID: model.id },
            },
            agent: { name: "research", prompt: "Research.", options: {} },
            system: [],
            messages: [{ role: "user", content: "Research." }],
            tools: {},
          }),
        ),
      ).pipe(Effect.provide(LLM.layer.pipe(Layer.provideMerge(models)))),
    );
    const owner = (event: LLM.SuccessStreamEvent) =>
      event.providerMetadata?.openchart?.delegateCallId ?? "root";
    const projected = events
      .filter((event) =>
        [
          "start-step",
          "finish-step",
          "tool-call",
          "tool-result",
          "tool-error",
          "text-delta",
        ].includes(event.type),
      )
      .map((event) => {
        const detail =
          event.type === "text-delta"
            ? event.text
            : "toolCallId" in event
              ? event.toolCallId
              : "";
        return `${event.type}:${owner(event)}:${detail}`;
      });
    expect(projected).toEqual([
      "start-step:root:",
      "tool-call:root:A",
      "start-step:A:",
      "text-delta:A:A-before",
      "tool-call:A:B",
      "start-step:B:",
      "text-delta:B:B-body",
      "finish-step:B:",
      `${failed ? "tool-error" : "tool-result"}:A:B`,
      "text-delta:A:A-after",
      "finish-step:A:",
      "tool-result:root:A",
      "text-delta:root:root-body",
      "finish-step:root:",
    ]);
    expect(events.some((event) => event.type === "custom")).toBe(false);
    expect(
      events.find(
        (event) => event.type === "finish-step" && owner(event) === "B",
      ),
    ).toMatchObject({ finishReason: failed ? "error" : "stop", usage });
    expect(
      events.find(
        (event) => event.type === "finish-step" && owner(event) === "root",
      ),
    ).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    expect(doStream).toHaveBeenCalledTimes(1);
    expect(doStream.mock.calls[0]?.[0].abortSignal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  },
);
