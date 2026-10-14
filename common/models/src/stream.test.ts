// Purpose: Locks provider-neutral delegate metadata and scoped step conformance.
import { conformProviderStream } from "./stream";
/* eslint-disable @typescript-eslint/no-explicit-any -- Synthetic streams cross the AI SDK transport boundary. */

import { describe, expect, test } from "vitest";
import {
  PROVIDER_DELEGATE_FINISH_STEP_KIND,
  PROVIDER_DELEGATE_START_STEP_KIND,
  OpenChartProviderMetadata,
} from "./provider-protocol";

// Raw wire fixtures intentionally do not use production marker constructors.
function ownedBy(delegateCallId: string, metadata?: any) {
  return {
    ...metadata,
    openchart: { ...metadata?.openchart, delegateCallId },
  };
}

function providerDelegateStartStepPart(id: string) {
  return {
    type: "custom",
    kind: PROVIDER_DELEGATE_START_STEP_KIND,
    providerMetadata: ownedBy(id),
  };
}

function providerDelegateFinishStepPart(id: string, finishReason: string) {
  const start = providerDelegateStartStepPart(id);
  return {
    ...start,
    kind: PROVIDER_DELEGATE_FINISH_STEP_KIND,
    providerMetadata: {
      openchart: {
        ...start.providerMetadata.openchart,
        finishDelegate: {
          finishReason,
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
        },
      },
    },
  };
}

const call = {
  description: "Inspect files",
  prompt: "Read the source",
  agent: "Explore",
};

async function conform(parts: any[]) {
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
  return collect(conformProviderStream(stream as any));
}

async function collect(stream: any) {
  const normalized = [];
  for await (const part of stream) {
    normalized.push(part);
  }
  return normalized;
}

describe("delegate metadata", () => {
  test("accepts ownership and opening independently", () => {
    for (const valid of [
      { delegateCallId: "delegate_1" },
      { openDelegate: call },
      { delegateCallId: "delegate_1", openDelegate: call },
    ]) {
      expect(OpenChartProviderMetadata.parse(valid)).toEqual(valid);
    }

    for (const invalid of [
      { delegateCallId: null },
      { delegateCallId: "" },
      { openDelegate: { description: "Inspect files", prompt: "" } },
      { openDelegate: { ...call, extra: true } },
    ]) {
      expect(OpenChartProviderMetadata.safeParse(invalid).success).toBe(false);
    }
  });

  test("maps only scoped custom markers to symmetric step events", async () => {
    const inDelegate = ownedBy("delegate_1");
    const parts = await conform([
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      providerDelegateStartStepPart("delegate_1"),
      { type: "text-start", id: "text_1", providerMetadata: inDelegate },
      {
        type: "text-delta",
        id: "text_1",
        text: "final answer",
        providerMetadata: inDelegate,
      },
      { type: "text-end", id: "text_1", providerMetadata: inDelegate },
      providerDelegateFinishStepPart("delegate_1", "stop"),
      {
        type: "finish-step",
        finishReason: "stop",
        usage: {},
        providerMetadata: undefined,
      },
      { type: "finish", finishReason: "stop", totalUsage: {} },
    ]);

    expect(parts.map((part) => part.type)).toEqual([
      "start",
      "start-step",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish-step",
      "finish",
    ]);
    const childStart = parts[2];
    const childFinish = parts[6];
    expect(childStart.providerMetadata.openchart.delegateCallId).toBe(
      "delegate_1",
    );
    expect(childFinish.providerMetadata.openchart.delegateCallId).toBe(
      "delegate_1",
    );
    expect(childFinish).toMatchObject({
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect((childFinish as any).providerMetadata.openchart).toEqual({
      delegateCallId: "delegate_1",
    });
  });

  test("rejects malformed scoped step markers", async () => {
    await expect(
      conform([
        {
          type: "custom",
          kind: "openchart.delegate-start-step",
        },
      ]),
    ).rejects.toThrow();
  });

  test("requires ownership and forbids opening on both scoped marker kinds", async () => {
    for (const marker of [
      providerDelegateStartStepPart("delegate_1"),
      providerDelegateFinishStepPart("delegate_1", "stop"),
    ]) {
      const openchart = marker.providerMetadata.openchart;
      for (const invalid of [
        { ...openchart, delegateCallId: undefined },
        { ...openchart, openDelegate: call },
      ]) {
        await expect(
          conform([{ ...marker, providerMetadata: { openchart: invalid } }]),
        ).rejects.toThrow();
      }
    }
  });

  test("preserves all start metadata while changing only the event shape", async () => {
    const providerMetadata = ownedBy("delegate_1", {
      vendor: { requestId: "request_1" },
    });
    const [part] = await conform([
      {
        type: "custom",
        kind: PROVIDER_DELEGATE_START_STEP_KIND,
        providerMetadata,
      },
    ]);

    expect(part).toEqual({ type: "start-step", providerMetadata });
  });

  test("strips only private finish payload while preserving ownership metadata", async () => {
    const marker = providerDelegateFinishStepPart("delegate_1", "error") as any;
    marker.providerMetadata = {
      ...marker.providerMetadata,
      vendor: { requestId: "request_1" },
      openchart: {
        ...marker.providerMetadata.openchart,
      },
    };
    const [part] = await conform([marker]);

    expect(part).toMatchObject({
      type: "finish-step",
      finishReason: "error",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      providerMetadata: {
        vendor: { requestId: "request_1" },
        openchart: { delegateCallId: "delegate_1" },
      },
    });
    expect((part as any).providerMetadata.openchart).not.toHaveProperty(
      "finishDelegate",
    );
  });

  test("rejects a finish marker with a missing, invalid, or negative payload", async () => {
    const inDelegate = ownedBy("delegate_1");
    const valid = (providerDelegateFinishStepPart("delegate_1", "stop") as any)
      .providerMetadata.openchart.finishDelegate;
    for (const finishDelegate of [
      undefined,
      { ...valid, finishReason: "cancelled" },
      { ...valid, usage: { ...valid.usage, inputTokens: -1 } },
    ]) {
      await expect(
        conform([
          {
            type: "custom",
            kind: PROVIDER_DELEGATE_FINISH_STEP_KIND,
            providerMetadata: {
              ...inDelegate,
              openchart: {
                ...(inDelegate.openchart as object),
                finishDelegate,
              },
            },
          },
        ]),
      ).rejects.toThrow();
    }
  });

  test("passes unrelated custom parts through unchanged", async () => {
    const custom = {
      type: "custom",
      kind: "vendor.keep-this",
      data: { value: 1 },
    };
    const [part] = await conform([custom]);

    expect(part).toBe(custom);
  });

  test("propagates an upstream stream error after already conformed output", async () => {
    const error = new Error("provider transport failed");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(providerDelegateStartStepPart("delegate_1"));
        controller.error(error);
      },
    });

    await expect(collect(conformProviderStream(stream as any))).rejects.toThrow(
      "provider transport failed",
    );
  });

  test("propagates downstream cancellation to the provider stream", async () => {
    const reason = new Error("consumer cancelled");
    let cancel!: (value: unknown) => void;
    const cancelled = new Promise<unknown>((resolve) => {
      cancel = resolve;
    });
    const stream = new ReadableStream({
      cancel(value) {
        cancel(value);
      },
    });
    const reader = conformProviderStream(stream as any).getReader();

    await reader.cancel(reason);

    expect(await cancelled).toBe(reason);
  });
});
