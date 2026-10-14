import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { SessionIndicator } from "@openchart/app/features/agent/components/sessions/session-list/session-indicator";

test("working takes precedence over unread, and read idle Sessions have no indicator", () => {
  const view = render(<SessionIndicator isActive isUnread />);
  expect(screen.getByRole("status", { name: "Working" })).toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Unread" }),
  ).not.toBeInTheDocument();
  view.rerender(<SessionIndicator isActive={false} isUnread />);
  expect(screen.getByRole("status", { name: "Unread" })).toBeInTheDocument();
  expect(
    screen.queryByRole("status", { name: "Working" }),
  ).not.toBeInTheDocument();
  view.rerender(<SessionIndicator isActive={false} isUnread={false} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
