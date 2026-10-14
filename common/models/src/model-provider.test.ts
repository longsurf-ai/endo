// Purpose: Locks public discovery schemas and the meaning of unknown variants.
import { CODEX } from "@openchart/models/model-tiers";

import { describe, expect, it } from "vitest";
import { AvailableModel, AvailableProvider } from "./model-provider";

const model: AvailableModel = {
  kind: "language",
  id: "native-model-id",
  providerID: CODEX,
  name: "Native model",
  capabilities: { input: {}, output: {} },
};

describe("discovery schemas", () => {
  it("rejects implementation settings and credentials from public metadata", () => {
    const provider = { id: CODEX, name: "Codex", models: [model] };

    expect(AvailableProvider.safeParse(provider).success).toBe(true);
    expect(AvailableModel.safeParse({ ...model, options: {} }).success).toBe(
      false,
    );
    expect(
      AvailableProvider.safeParse({ ...provider, key: "secret" }).success,
    ).toBe(false);
  });

  it("preserves unknown variants separately from no selectable variants", () => {
    const unknown = AvailableModel.parse(model);
    const empty = AvailableModel.parse({ ...model, availableVariants: [] });

    expect(unknown).not.toHaveProperty("availableVariants");
    expect(empty.availableVariants).toEqual([]);
  });
});
