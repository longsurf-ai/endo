import { renderWithToaster as render } from "@openchart/app/testing/test-utils";
// Purpose: Suggested prompts submit like typed input and never replace a draft.
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { AgentNewThread } from "@openchart/app/features/agent/components/thread/agent-thread";
import type { PromptSuggestion } from "@openchart/app/lib/proactive/proactive";

const agent = vi.hoisted(() => ({
  commands: { data: [], isPending: false, isError: false },
}));
vi.mock("@openchart/app/lib/agent/provider", () => ({
  useAgentContext: () => ({ agent }),
}));

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

const suggestions: readonly PromptSuggestion[] = [
  {
    title: "📊 Compare NVDA and AMD",
    prompt: "Compare NVDA and AMD over the past year.",
  },
  {
    title: "🔔 Alert me when AAPL closes above its 50-day average",
    prompt: "Alert me when AAPL closes above its 50-day moving average.",
  },
];

test("selecting a suggestion shows its title and submits its prompt", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<AgentNewThread onSubmit={onSubmit} suggestions={suggestions} />);
  await userEvent.click(
    screen.getByRole("button", { name: suggestions[1]!.title }),
  );
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
    text: suggestions[1]!.prompt,
    quote: undefined,
    attachments: [],
  });
});

test("suggestions hide while drafting and are omitted without a composer", async () => {
  const onSubmit = vi.fn();
  const { rerender } = render(
    <AgentNewThread onSubmit={onSubmit} suggestions={suggestions} />,
  );
  const group = screen.getByRole("group", { name: "Suggested prompts" });
  expect(group).not.toHaveClass("invisible");
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message" }),
    "Research earnings",
  );
  expect(group).toHaveClass("invisible");
  rerender(
    <AgentNewThread onSubmit={onSubmit} suggestions={suggestions} readOnly />,
  );
  expect(
    screen.queryByRole("group", { name: "Suggested prompts" }),
  ).not.toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

test("Refresh rotates through the inventory four at a time and wraps", async () => {
  const inventory: readonly PromptSuggestion[] = ["A", "B", "C", "D", "E"].map(
    (letter) => ({ title: `Title ${letter}`, prompt: `Prompt ${letter}` }),
  );
  const shown = () =>
    screen
      .getAllByRole("button", { name: /^Title/ })
      .map((button) => button.textContent);
  const { rerender } = render(
    <AgentNewThread onSubmit={vi.fn()} suggestions={inventory} />,
  );
  expect(shown()).toEqual(["Title A", "Title B", "Title C", "Title D"]);
  const refresh = screen.getByRole("button", { name: "Refresh suggestions" });
  await userEvent.click(refresh);
  expect(shown()).toEqual(["Title E", "Title A", "Title B", "Title C"]);
  await userEvent.click(refresh);
  expect(shown()).toEqual(["Title D", "Title E", "Title A", "Title B"]);
  rerender(
    <AgentNewThread onSubmit={vi.fn()} suggestions={inventory.slice(0, 4)} />,
  );
  expect(
    screen.queryByRole("button", { name: "Refresh suggestions" }),
  ).not.toBeInTheDocument();
});
