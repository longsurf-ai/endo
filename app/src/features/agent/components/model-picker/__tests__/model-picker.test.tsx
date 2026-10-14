// Purpose: Verify tier selections retain native names, variants, and provider-local fallback.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  CLAUDE_CODE,
  CODEX,
  TIER3,
  TIER4,
  TIER5,
  classifyModels,
  modelChoices,
} from "@openchart/models/model-tiers";
import type { AvailableModel } from "@openchart/models/model-provider";
import { claudeCodeTiers } from "@openchart/models/providers/claude-code/tiers";
import { codexTiers } from "@openchart/models/providers/codex/tiers";
import { ModelPicker } from "@openchart/app/features/agent/components/model-picker/model-picker";
import { resolveModel } from "@openchart/app/lib/agent/model-selection";

beforeEach(() => {
  // cmdk scrolls the selected row into view; jsdom has no layout.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

test("menus offer only present tiers with native names, efforts, and saved tier fallback", async () => {
  const providers = [
    {
      id: CODEX,
      name: "Codex",
      tiers: codexTiers,
      ids: [
        "gpt-6-astra",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "future-model",
      ],
    },
    {
      id: CLAUDE_CODE,
      name: "Claude Code",
      tiers: claudeCodeTiers,
      ids: ["fable[1m]", "claude-fable-5-1[1m]", "fable", "claude-fable-5-1"],
    },
  ].flatMap(({ id, name, tiers, ids }) =>
    modelChoices({
      id,
      name,
      models: classifyModels(
        tiers,
        ids.map((modelID): AvailableModel => ({
          kind: "language",
          id: modelID,
          name: modelID,
          providerID: id,
          capabilities: { input: {}, output: {} },
          availableVariants: ["low", "high"],
        })),
      ),
    }),
  );
  const original = structuredClone(providers);
  expect(resolveModel(providers)).toEqual({
    providerID: CODEX,
    modelID: TIER4,
  });
  const select = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <ModelPicker
      providers={providers}
      model={{
        providerID: CODEX,
        modelID: TIER4,
        selectedVariant: "high",
      }}
      onChange={select}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "gpt-6-astra high" }));
  expect(screen.getByRole("radio", { name: "high" })).toBeChecked();
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual([
    "gpt-6-astraCodex",
    "gpt-5.6-solCodex",
    "gpt-5.6-terraCodex",
    "gpt-5.6-lunaCodex",
    "fable[1m]Claude Code",
  ]);
  expect(select).not.toHaveBeenCalled();
  await user.click(screen.getByRole("option", { name: "gpt-5.6-sol Codex" }));
  expect(select).toHaveBeenLastCalledWith({
    providerID: CODEX,
    modelID: TIER3,
  });
  view.rerender(
    <ModelPicker
      providers={providers}
      model={resolveModel(providers, { providerID: CODEX, modelID: TIER5 })}
      onChange={select}
    />,
  );
  expect(
    screen.getByRole("combobox", {
      name: "gpt-6-astra Default",
    }),
  ).toBeInTheDocument();
  expect(providers).toEqual(original);
});
