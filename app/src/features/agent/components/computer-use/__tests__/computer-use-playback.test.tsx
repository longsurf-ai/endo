// Purpose: Preserve the Computer Use view while browsing and following a work cycle's frames.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ComputerSequence } from "@openchart/app/features/agent/ag-ui/tool-media";
import { ComputerUsePlayback } from "@openchart/app/features/agent/components/computer-use/computer-use-playback";

function sequence(...ids: [string, ...string[]]): ComputerSequence {
  const frames = ids.map((id) => ({
    id,
    title: "Computer use",
    mime: "image/png",
    url: `https://example.com/${id}.png`,
  }));
  return { id: "work", frames: [frames[0]!, ...frames.slice(1)] };
}

test("preserves chrome, footer and cursor while browsing real screenshots", () => {
  const { rerender } = render(
    <ComputerUsePlayback sequence={sequence("first", "second")} />,
  );
  const computer = screen.getByTitle("Illustrative cursor movement");
  expect(computer).toHaveClass("rounded-2xl", "overflow-hidden");
  expect(within(computer).getByText("2/2")).toBeVisible();
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://example.com/second.png",
  );
  // The cursor is decorative and has no accessible role.
  // eslint-disable-next-line testing-library/no-node-access
  const cursor = computer.querySelector('svg[aria-hidden="true"]')!;
  expect(cursor).toHaveStyle({ left: "58%", top: "44%" });
  expect(
    screen
      .getByRole("toolbar", { name: "Computer use preview controls" })
      .contains(computer),
  ).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Previous screenshot" }));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://example.com/first.png",
  );
  expect(screen.getByText("1/2")).toBeVisible();
  expect(cursor).toHaveStyle({ left: "36%", top: "30%" });

  rerender(
    <ComputerUsePlayback sequence={sequence("first", "second", "third")} />,
  );
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://example.com/first.png",
  );
  expect(screen.getByText("1/3")).toBeVisible();
  expect(cursor).toHaveStyle({ left: "36%", top: "30%" });
  fireEvent.click(screen.getByRole("button", { name: "Next screenshot" }));
  expect(screen.getByText("2/3")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Follow latest screenshot" }),
  );
  expect(screen.getByText("3/3")).toBeVisible();
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://example.com/third.png",
  );
  expect(cursor).toHaveStyle({ left: "44%", top: "68%" });

  rerender(
    <ComputerUsePlayback
      sequence={sequence("first", "second", "third", "fourth")}
    />,
  );
  expect(screen.getByText("4/4")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Next screenshot" }),
  ).toBeDisabled();
});

test("another work cycle resets steps and selection while keeping floating presentation", () => {
  const { rerender } = render(
    <ComputerUsePlayback sequence={sequence("first", "second")} />,
  );
  const preview = screen.getByRole("region", { name: "Computer use preview" });
  fireEvent.click(screen.getByRole("button", { name: "Previous screenshot" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Minimize computer screen" }),
  );
  rerender(
    <ComputerUsePlayback
      sequence={{ ...sequence("new-first"), id: "next-work" }}
    />,
  );
  expect(screen.getByRole("region", { name: "Computer use preview" })).toBe(
    preview,
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show computer screen" }));
  expect(screen.getByText("1/1")).toBeVisible();
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://example.com/new-first.png",
  );
  expect(
    screen.getByRole("button", { name: "Follow latest screenshot" }),
  ).toHaveAttribute("aria-pressed", "true");
});
