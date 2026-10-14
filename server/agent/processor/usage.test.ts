// Purpose: Locks per-step token accounting and catalog reference-cost projection.

import type { AvailableModel } from "@openchart/models/model-provider";
import type { LanguageModelUsage } from "ai";
import { describe, expect, test } from "vitest";
import { getUsage } from "./usage";

const model: AvailableModel = {
  kind: "language",
  providerID: "test",
  id: "test-model",
  name: "Test model",
  capabilities: { input: {}, output: {} },
  cost: {
    input: 3,
    output: 15,
    cache: { read: 0.3, write: 3.75 },
    contextTiers: [],
  },
};

function usage(
  overrides: Partial<LanguageModelUsage> = {},
): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
    ...overrides,
  };
}

describe("processor usage", () => {
  test("charges output once and keeps reasoning as a subset", () => {
    const result = getUsage(
      model,
      usage({
        inputTokens: 160,
        inputTokenDetails: {
          noCacheTokens: 100,
          cacheReadTokens: 40,
          cacheWriteTokens: 20,
        },
        outputTokens: 20,
        outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
      }),
    );

    expect(result.tokens).toEqual({
      input: 100,
      output: 20,
      reasoning: 8,
      cache: { read: 40, write: 20 },
    });
    expect(result.cost).toBeCloseTo(0.000687, 10);
  });

  test("derives missing non-cache and output totals from their breakdowns", () => {
    const result = getUsage(
      model,
      usage({
        inputTokens: 100,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
        },
        outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
      }),
    );

    expect(result.tokens).toEqual({
      input: 70,
      output: 20,
      reasoning: 8,
      cache: { read: 20, write: 10 },
    });
  });

  test("does not invent negative uncached usage when the input total is absent", () => {
    const result = getUsage(
      model,
      usage({
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: 8 },
      }),
    );

    expect(result.tokens.input).toBe(0);
    expect(result.tokens.output).toBe(8);
    expect(result.tokens.cache).toEqual({ read: 20, write: 10 });
  });

  test("selects the highest exceeded context threshold regardless of tier order", () => {
    const tiered: AvailableModel = {
      ...model,
      cost: {
        input: 1,
        output: 1,
        cache: { read: 1, write: 1 },
        contextTiers: [
          { threshold: 200, input: 3, output: 3, cache: { read: 3, write: 3 } },
          { threshold: 100, input: 2, output: 2, cache: { read: 2, write: 2 } },
        ],
      },
    };
    const step = (input: number, read: number, write: number) =>
      usage({
        inputTokenDetails: {
          noCacheTokens: input,
          cacheReadTokens: read,
          cacheWriteTokens: write,
        },
        outputTokens: 10,
      });

    // Cache reads select the tier; cache writes are priced but do not select it.
    expect(getUsage(tiered, step(80, 20, 150)).cost).toBeCloseTo(0.00026, 10);
    expect(getUsage(tiered, step(81, 20, 0)).cost).toBeCloseTo(0.000222, 10);
    expect(getUsage(tiered, step(180, 20, 0)).cost).toBeCloseTo(0.00042, 10);
    expect(getUsage(tiered, step(181, 20, 0)).cost).toBeCloseTo(0.000633, 10);
  });

  test("preserves usage when catalog prices are unknown", () => {
    expect(
      getUsage({ ...model, cost: undefined }, usage({ inputTokens: 15 })),
    ).toEqual({
      cost: 0,
      tokens: {
        input: 15,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    });
  });
});
