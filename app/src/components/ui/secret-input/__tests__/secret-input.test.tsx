// Purpose: Verify secret actions are keyboard accessible, disabled during saving, and honest about clipboard failure.
import { screen } from "@testing-library/react";
import {
  renderWithToaster as render,
  findErrorToast,
} from "@openchart/app/testing/test-utils";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { SecretInput } from "@openchart/app/components/ui/secret-input";

test("reveals the current draft, reports clipboard failure, and disables both actions while saving", async () => {
  const user = userEvent.setup();
  const view = render(
    <SecretInput aria-label="API key" value="draft-only" onChange={() => {}} />,
  );
  const input = screen.getByLabelText("API key");
  expect(input).toHaveAttribute("type", "password");
  await user.tab();
  expect(input).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Reveal" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(input).toHaveAttribute("type", "text");
  const copy = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("clipboard unavailable"))
    .mockResolvedValueOnce(undefined);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  const error = await findErrorToast("Couldn’t copy to clipboard");
  expect(error).toHaveTextContent("Select the text and copy it manually.");
  expect(error).not.toHaveTextContent("draft-only");
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText("Copied")).toBeInTheDocument();
  expect(copy).toHaveBeenLastCalledWith("draft-only");
  view.rerender(
    <SecretInput
      aria-label="API key"
      value="draft-only"
      onChange={() => {}}
      disabled
    />,
  );
  expect(screen.getByRole("button", { name: "Hide" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  copy.mockRestore();
});
