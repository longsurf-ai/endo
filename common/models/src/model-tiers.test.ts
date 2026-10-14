// Purpose: Proves alias preference and provider-local downward fallback without guessing availability.

import { describe, expect, it } from "vitest";
import { claudeCodeTiers } from "@openchart/models/providers/claude-code/tiers";
import { codexTiers } from "@openchart/models/providers/codex/tiers";
import type { AvailableModel } from "./model-provider";
import {
  CLAUDE_CODE,
  CODEX,
  TIER1,
  TIER2,
  TIER3,
  TIER4,
  TIER5,
  ModelTier,
  classifyModels,
  resolveModelTier,
  modelChoices,
} from "./model-tiers";

function model(
  id: string,
  providerID: string = CLAUDE_CODE,
  aliases?: string[],
): AvailableModel {
  return {
    id,
    providerID,
    kind: "language",
    name: id,
    aliases,
    capabilities: { input: {}, output: {} },
  };
}

describe("logical model tiers", () => {
  it("accepts only the five logical IDs", () => {
    for (const id of [TIER1, TIER2, TIER3, TIER4, TIER5])
      expect(ModelTier.parse(id)).toBe(id);
    for (const id of ["tier0", "tier6", "fable", "gpt-6-astra"])
      expect(ModelTier.safeParse(id).success).toBe(false);
  });

  it("prefers listed aliases regardless of discovery order, preserving native metadata", () => {
    const native = {
      ...model("fable[1m]"),
      limit: { context: 1_000_000, output: 32_000 },
    };
    const discovered = [
      model("claude-fable-5[1m]"),
      model("claude-fable-5-1[1m]"),
      native,
      model("opus"),
    ];
    const original = structuredClone(discovered);
    const models = classifyModels(claudeCodeTiers, discovered);
    expect(resolveModelTier(CLAUDE_CODE, TIER4, models)).toMatchObject({
      id: native.id,
      tier: 4,
      limit: native.limit,
    });
    expect(discovered).toEqual(original);
    expect(
      resolveModelTier(
        CLAUDE_CODE,
        TIER4,
        models.filter((model) => model.id !== native.id),
      )?.id,
    ).toBe("claude-fable-5-1[1m]");
    expect(
      resolveModelTier(
        CLAUDE_CODE,
        TIER4,
        models.filter(
          (model) => ![native.id, "claude-fable-5-1[1m]"].includes(model.id),
        ),
      )?.id,
    ).toBe("claude-fable-5[1m]");
  });

  it("recognizes canonical names without replacing the native SDK ID", () => {
    const models = classifyModels(claudeCodeTiers, [
      model("account-specific-alias", CLAUDE_CODE, ["claude-fable-5-1[1m]"]),
    ]);
    expect(resolveModelTier(CLAUDE_CODE, TIER5, models)?.id).toBe(
      "account-specific-alias",
    );
  });

  it("falls downward only, stays within one provider, and ignores unclassified names", () => {
    const models = classifyModels(claudeCodeTiers, [
      model("future-fable"),
      model("opus"),
      model("haiku"),
    ]);
    expect(resolveModelTier(CLAUDE_CODE, TIER5, models)?.id).toBe("opus");
    expect(resolveModelTier(CLAUDE_CODE, TIER2, models)?.id).toBe("haiku");
    expect(resolveModelTier(CODEX, TIER5, models)).toBeUndefined();
    expect(
      resolveModelTier(
        CLAUDE_CODE,
        TIER1,
        classifyModels(claudeCodeTiers, [model("opus")]),
      ),
    ).toBeUndefined();
    expect(
      resolveModelTier(
        CLAUDE_CODE,
        TIER5,
        classifyModels(claudeCodeTiers, [model("future-fable")]),
      ),
    ).toBeUndefined();
  });

  it("resolves Codex tiers to Luna, Terra, Sol, and Astra with downward fallback", () => {
    const models = classifyModels(codexTiers, [
      model("gpt-5.5", CODEX),
      model("gpt-5.6-sol", CODEX),
      model("gpt-5.6-luna", CODEX),
      model("gpt-6-astra", CODEX),
      model("gpt-5.6-terra", CODEX),
    ]);
    expect(
      [TIER1, TIER2, TIER3, TIER4, TIER5].map(
        (tier) => resolveModelTier(CODEX, tier, models)?.id,
      ),
    ).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-6-astra",
    ]);
    const withoutAstra = models.filter((model) => model.id !== "gpt-6-astra");
    expect(resolveModelTier(CODEX, TIER4, withoutAstra)?.id).toBe(
      "gpt-5.6-sol",
    );
    const withoutSol = withoutAstra.filter(
      (model) => model.id !== "gpt-5.6-sol",
    );
    expect(resolveModelTier(CODEX, TIER3, withoutSol)?.id).toBe("gpt-5.5");
    expect(resolveModelTier(CODEX, TIER4, withoutSol)?.id).toBe("gpt-5.5");
    expect(
      resolveModelTier(
        CODEX,
        TIER4,
        withoutSol.filter((model) => model.id !== "gpt-5.5"),
      )?.id,
    ).toBe("gpt-5.6-terra");
  });

  it.each([
    [["gpt-6-sol", "gpt-6.1-sol"], "gpt-6.1-sol"],
    [["gpt-6-sol"], "gpt-6-sol"],
  ])("resolves discovered Sol candidates %j to %s", (discovered, expected) => {
    const models = classifyModels(
      codexTiers,
      ["gpt-5.5", "gpt-5.6-sol", ...discovered].map((id) => model(id, CODEX)),
    );
    expect(resolveModelTier(CODEX, TIER3, models)?.id).toBe(expected);
    expect(resolveModelTier(CODEX, TIER4, models)?.id).toBe(expected);
  });

  it("publishes logical choices with the metadata of the model each choice actually resolves to", () => {
    const models = classifyModels(codexTiers, [
      model("gpt-5.6-luna", CODEX),
      model("gpt-6-astra", CODEX),
    ]);
    const choices = modelChoices({ id: CODEX, name: "Codex", models })[0]!
      .models;
    expect(choices.map(({ id }) => id)).toEqual([
      TIER5,
      TIER4,
      TIER3,
      TIER2,
      TIER1,
    ]);
    expect(choices[0]?.name).toBe("gpt-6-astra");
    expect(choices[1]?.name).toBe("gpt-6-astra");
    expect(choices[3]?.name).toBe("gpt-5.6-luna");
    expect(choices[0]?.providerID).toBe(CODEX);
  });

  it("omits unsupported providers and unclassified native models from prompt choices", () => {
    expect(modelChoices({ id: "typo", name: "Unknown", models: [] })).toEqual(
      [],
    );
    expect(
      modelChoices({
        id: CODEX,
        name: "Codex",
        models: [model("future-model", CODEX)],
      })[0]?.models,
    ).toEqual([]);
  });
});
