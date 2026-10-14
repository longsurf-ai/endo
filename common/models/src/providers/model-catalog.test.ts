// Purpose: Locks catalog enrichment thresholds and unknown metadata semantics.

import { describe, expect, it } from "vitest";
import { ModelsDev } from "@openchart/models/catalog";
import { catalogModelMetadata } from "./model-catalog";

function catalogModel() {
  return ModelsDev.Model.parse({
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite",
    release_date: "2026-05-07",
    attachment: true,
    reasoning: true,
    temperature: true,
    tool_call: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 65_536 },
    cost: {
      input: 1,
      output: 6,
      cache_read: 0.1,
      tiers: [
        {
          input: 2,
          output: 9,
          cache_read: 0.2,
          tier: { type: "context", size: 272_000 },
        },
      ],
    },
  });
}

describe("catalogModelMetadata", () => {
  it("preserves capabilities, limits, and cost thresholds without mutating the catalog", () => {
    const catalog = catalogModel();
    const original = structuredClone(catalog);
    const metadata = catalogModelMetadata(catalog);

    expect(metadata).toMatchObject({
      capabilities: {
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, image: true },
        output: { text: true, image: false },
      },
      limit: { context: 1_000_000, output: 65_536 },
      cost: {
        input: 1,
        output: 6,
        cache: { read: 0.1, write: undefined },
        contextTiers: [
          {
            threshold: 272_000,
            input: 2,
            output: 9,
            cache: { read: 0.2, write: undefined },
          },
        ],
      },
    });
    expect(catalog).toEqual(original);
  });

  it("keeps unknown prices and modalities unknown", () => {
    const catalog = catalogModel();
    delete catalog.cost;
    delete catalog.modalities;

    const metadata = catalogModelMetadata(catalog);

    expect(metadata.cost).toBeUndefined();
    expect(metadata.capabilities.input).toEqual({});
    expect(metadata.capabilities.output).toEqual({});
  });
});
