// Purpose: Keep live screenshot presentation independent of tool disclosure lifecycle.
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ComputerUseFloating } from "@openchart/app/features/agent/components/computer-use/computer-use-floating";

import { Screenshot } from "@openchart/app/features/agent/components/computer-use/screenshot";

test("new frames reuse the floating window and respect manual minimization", () => {
  const { rerender } = render(
    <ComputerUseFloating>
      <Screenshot src="https://example.com/first.png" />
    </ComputerUseFloating>,
  );
  const region = screen.getByRole("region", { name: "Computer use preview" });
  fireEvent.click(
    screen.getByRole("button", { name: "Move viewer from bottom-right" }),
  );
  rerender(
    <ComputerUseFloating>
      <Screenshot src="https://example.com/next.png" />
    </ComputerUseFloating>,
  );
  expect(screen.getByRole("region", { name: "Computer use preview" })).toBe(
    region,
  );
  expect(
    screen.getByRole("img", { name: "Computer screenshot" }),
  ).toHaveAttribute("src", "https://example.com/next.png");
  fireEvent.click(
    screen.getByRole("button", { name: "Minimize computer screen" }),
  );
  rerender(
    <ComputerUseFloating>
      <Screenshot src="https://example.com/first.png" />
    </ComputerUseFloating>,
  );
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show computer screen" }));
  expect(screen.getByRole("img")).toBeInTheDocument();
});
