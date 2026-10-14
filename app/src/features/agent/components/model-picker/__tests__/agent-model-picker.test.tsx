// Purpose: Shows managed provider installation inside the composer model control.
import { render, screen, within } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CODEX, TIER4 } from "@openchart/models/model-tiers";

import { AgentModelPicker } from "@openchart/app/features/agent/components/model-picker/model-picker";

const setup = vi.hoisted(() => ({
  codex: { data: { status: "idle", action: "install" } },
  claude: { data: { status: "idle", action: "install" } },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({
    agent: {
      modelProviders: {
        data: [
          {
            id: "codex",
            name: "Codex",
            models: [
              {
                id: "tier4",
                name: "GPT-6-Astra",
                providerID: "codex",
                tier: 4,
              },
            ],
          },
        ],
        isPending: false,
        isError: false,
      },
      providerSetup: [setup.codex, setup.claude],
    },
  }),
}));

test("shows setup inside the model picker only while providers install", () => {
  setup.codex.data.status = "idle";
  setup.claude.data.status = "idle";
  const props = {
    model: { providerID: CODEX, modelID: TIER4 },
    onChange: vi.fn(),
  };
  const view = render(<AgentModelPicker {...props} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "GPT-6-Astra" })).toBeEnabled();

  setup.codex.data.status = "running";
  setup.claude.data.status = "running";
  view.rerender(<AgentModelPicker {...props} />);
  const picker = screen.getByRole("combobox", { name: "Setting up…" });
  expect(within(picker).getByRole("status")).toHaveTextContent("Setting up…");
  expect(picker).toBeEnabled();

  setup.codex.data.status = "succeeded";
  view.rerender(<AgentModelPicker {...props} />);
  expect(screen.getByRole("status")).toHaveTextContent("Setting up…");

  setup.claude.data.status = "succeeded";
  view.rerender(<AgentModelPicker {...props} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "GPT-6-Astra" })).toBeEnabled();
});
