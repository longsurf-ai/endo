// Purpose: Enforces the provider boundary and metadata/result type correlation.
import type { AsyncIterableStream, TextStreamPart } from "ai";
import type { ToolSet } from "@ai-sdk/provider-utils";
import { expect, expectTypeOf, test } from "vitest";
import {
  OpenChartProviderMetadata,
  ProviderNativeToolOutput,
  ProviderToolMedia,
  isObservedProviderTool,
  type ProviderToolResult,
} from "./provider-protocol";
import { conformProviderStream, type ModelStreamEvent } from "./stream";

async function conform<ApplicationOutput = unknown>(...parts: unknown[]) {
  const stream = new ReadableStream<unknown>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  }) as unknown as AsyncIterableStream<TextStreamPart<ToolSet>>;
  const result: ModelStreamEvent<ApplicationOutput>[] = [];
  for await (const part of conformProviderStream<ApplicationOutput>(stream))
    result.push(part);
  return result;
}

const media = {
  output: "Calculator shows 42",
  attachments: [
    { mime: "image/png" as const, url: "data:image/png;base64,NDI=" },
  ],
};
const result = {
  type: "tool-result",
  toolCallId: "capture",
  toolName: "capture",
  input: {},
  providerExecuted: true,
  providerMetadata: { openchart: { toolMedia: true } },
  output: media,
};

test.each([
  null,
  [],
  { toolMedia: false },
  { toolMedia: "true" },
  { toolExecution: "native" },
  { toolExecution: "provider-mcp", toolMedia: true },
  { toolMeida: true },
  { delegateCallId: null },
  { delegateCallId: "" },
  { openDelegate: { description: "Inspect", prompt: "" } },
])(
  "rejects malformed metadata before even a text event leaves the boundary: %j",
  async (openchart) => {
    await expect(
      conform({
        type: "text-start",
        id: "text",
        providerMetadata: { openchart },
      }),
    ).rejects.toThrow();
  },
);

test("preserves vendor metadata and root ownership without inventing markers", async () => {
  const event = {
    type: "text-start",
    id: "text",
    providerMetadata: { vendor: { opaque: [1, true] } },
  };
  expect(await conform(event)).toEqual([event]);
  expect(OpenChartProviderMetadata.parse({})).toEqual({});
});

test("parses native media before consumption and preserves delegate ownership", async () => {
  const delegateCallId = "agent";
  const [part] = await conform({
    ...result,
    providerMetadata: {
      vendor: { id: "native" },
      openchart: { toolMedia: true, delegateCallId },
    },
  });
  expect(part?.providerMetadata?.openchart?.delegateCallId).toBe(
    delegateCallId,
  );
  if (part?.type !== "tool-result" || !isObservedProviderTool(part))
    throw new Error("Expected typed native result");
  expectTypeOf(part.output).toEqualTypeOf<ProviderNativeToolOutput>();
  expect(part.output).toEqual(media);
  expect(part.providerMetadata?.vendor).toEqual({ id: "native" });
  expect(part.providerMetadata?.openchart).toEqual({ delegateCallId });
});

test.each([
  { ...result, output: "not a media envelope" },
  { ...result, output: { output: "empty", attachments: [] } },
  { ...result, providerExecuted: false },
  { ...result, providerExecuted: undefined },
  { ...result, providerMetadata: undefined, output: new Date() },
])("rejects invalid native results at the boundary", async (part) => {
  await expect(conform(part)).rejects.toThrow();
});

test.each([
  { output: "plain text" },
  { output: 42 },
  { output: false },
  { output: null },
  { output: [1, "value"] },
  { output: { attachments: "provider-specific", computerUse: false } },
  { output: media },
])(
  "wraps unmarked JSON without interpreting its shape: $output",
  async ({ output }) => {
    const [part] = await conform({
      ...result,
      providerMetadata: undefined,
      output,
    });
    if (part?.type !== "tool-result" || !isObservedProviderTool(part))
      throw new Error("Expected typed native result");
    expectTypeOf(part.output).toEqualTypeOf<ProviderNativeToolOutput>();
    expect(part.output).toEqual({ output, attachments: [] });
    expect(ProviderNativeToolOutput.parse(part.output)).toEqual(part.output);
  },
);

test.each([false, true])(
  "retains the host's exact callback result (managed: %s)",
  async (managed) => {
    const output = { title: "Lookup", opaque: new Map([["answer", 42]]) };
    const [part] = await conform<typeof output>({
      ...result,
      providerExecuted: managed,
      providerMetadata: managed
        ? { openchart: { toolExecution: "provider-mcp" } }
        : undefined,
      output,
    });
    if (part?.type !== "tool-result" || isObservedProviderTool(part))
      throw new Error("Expected application result");
    expectTypeOf(part.output).toEqualTypeOf<typeof output>();
    expect(part.output).toBe(output);
  },
);

test("display-only frames remain distinct from model-facing attachments", async () => {
  const output = {
    output: "Home / X",
    attachments: [],
    computerUse: { title: "Computer use", screenshot: media.attachments[0] },
  };
  const [part] = await conform({ ...result, output });
  expect(part).toMatchObject({ output });
  expect(part?.providerMetadata?.openchart).not.toHaveProperty("toolMedia");
  expect(ProviderToolMedia.parse(media)).not.toHaveProperty("computerUse");
});

test.each([
  "file:///tmp/screen.png",
  "javascript:alert(1)",
  "data:image/svg+xml;base64,PHN2Zz4=",
])("rejects unsupported media source %s", async (url) => {
  await expect(
    conform({
      ...result,
      output: { ...media, attachments: [{ mime: "image/png", url }] },
    }),
  ).rejects.toThrow();
});

test("rejects private completion payloads outside scoped finish markers", async () => {
  const finishDelegate = {
    finishReason: "stop",
    usage: {
      inputTokens: 0,
      inputTokenDetails: {
        noCacheTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokens: 0,
      outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
      totalTokens: 0,
    },
  };
  await expect(
    conform({
      type: "text-start",
      id: "text",
      providerMetadata: { openchart: { finishDelegate } },
    }),
  ).rejects.toThrow("requires a scoped finish marker");
});

test("types reject marker/payload mismatches and leaked transport metadata", () => {
  type UnwrappedNative = {
    providerExecuted: true;
    output: string;
  };
  type MissingAttachments = {
    providerExecuted: true;
    output: { output: string };
  };
  type LeakedMedia = {
    providerExecuted: true;
    providerMetadata: { openchart: { toolMedia: true } };
    output: ProviderNativeToolOutput;
  };
  type LocalMedia = {
    providerExecuted: false;
    providerMetadata: { openchart: { toolMedia: true } };
    output: ProviderNativeToolOutput;
  };
  type ConflictingOrigin = {
    providerExecuted: true;
    providerMetadata: {
      openchart: { toolMedia: true; toolExecution: "provider-mcp" };
    };
    output: ProviderNativeToolOutput;
  };
  expectTypeOf<UnwrappedNative>().not.toExtend<ProviderToolResult>();
  expectTypeOf<MissingAttachments>().not.toExtend<ProviderToolResult>();
  expectTypeOf<LeakedMedia>().not.toExtend<ProviderToolResult>();
  expectTypeOf<LocalMedia>().not.toExtend<ProviderToolResult>();
  expectTypeOf<ConflictingOrigin>().not.toExtend<ProviderToolResult>();
  type LeakedStep = {
    type: "text-start";
    id: string;
    providerMetadata: { openchart: { finishDelegate: object } };
  };
  expectTypeOf<LeakedStep>().not.toExtend<ModelStreamEvent>();
});
