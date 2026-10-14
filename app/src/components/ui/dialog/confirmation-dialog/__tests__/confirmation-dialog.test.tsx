import { Button } from "@/components/ui/button";
import { render } from "@testing-library/react";
import { rtlRender, screen, userEvent, waitFor } from "@/testing/test-utils";

import { ConfirmationDialog } from "../confirmation-dialog";

test("should handle confirmation flow", async () => {
  const titleText = "Are you sure?";
  const bodyText = "Are you sure you want to delete this item?";
  const confirmationButtonText = "Confirm";
  const openButtonText = "Open";

  await rtlRender(
    <ConfirmationDialog
      icon="danger"
      title={titleText}
      body={bodyText}
      confirmButton={<Button>{confirmationButtonText}</Button>}
      triggerButton={<Button>{openButtonText}</Button>}
    />,
  );

  expect(screen.queryByText(titleText)).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: openButtonText }));

  expect(await screen.findByText(titleText)).toBeInTheDocument();

  expect(screen.getByText(bodyText)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  await waitFor(() =>
    expect(screen.queryByText(titleText)).not.toBeInTheDocument(),
  );

  expect(screen.queryByText(bodyText)).not.toBeInTheDocument();
});

test("pending confirmation blocks Cancel, Escape and Close until the action settles", async () => {
  const confirm = vi.fn();
  const element = (pending: boolean) => (
    <ConfirmationDialog
      title="Remove column"
      body="The code file stays in your workspace."
      triggerButton={<Button>Remove</Button>}
      confirmButton={
        <Button disabled={pending} onClick={confirm}>
          Confirm
        </Button>
      }
      pending={pending}
    />
  );
  const { rerender } = render(element(false));
  await userEvent.click(screen.getByRole("button", { name: "Remove" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  rerender(element(true));
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("dialog", { name: "Remove column" }),
  ).toBeInTheDocument();
  rerender(element(false));
  expect(
    screen.getByRole("dialog", { name: "Remove column" }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(confirm).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
});
