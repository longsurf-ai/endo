// Purpose: Verify the settings controls retain accessible selection and loading behavior.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { Switch } from "@openchart/app/components/ui/form/switch";
import { DropdownControl } from "@openchart/app/components/ui/settings/dropdown-control";

test("dropdown selects through Radix and loading switches cannot change their saved value", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  const toggle = vi.fn();
  const view = render(
    <>
      <DropdownControl
        aria-label="Model"
        value="one"
        options={[
          { value: "one", name: "Model one" },
          { value: "two", name: "Model two" },
        ]}
        onChange={select}
      />
      <Switch
        aria-label="Enabled"
        checked={false}
        loading
        onCheckedChange={toggle}
      />
    </>,
  );
  await user.click(screen.getByRole("button", { name: "Model" }));
  await user.click(screen.getByRole("menuitem", { name: "Model two" }));
  expect(select).toHaveBeenCalledWith("two");
  const loading = screen.getByRole("switch", { name: "Enabled" });
  expect(loading).toBeDisabled();
  expect(loading).toHaveAttribute("aria-busy", "true");
  expect(toggle).not.toHaveBeenCalled();
  view.rerender(
    <DropdownControl
      aria-label="Model"
      value="only"
      options={[{ value: "only", name: "Only model" }]}
      onChange={select}
    />,
  );
  expect(screen.getByText("Only model")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Model" }),
  ).not.toBeInTheDocument();
});

test("dropdown labels a saved value independently of its selectable options", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  render(
    <DropdownControl
      aria-label="Model"
      value="saved-model"
      selectedLabel="Saved model"
      options={[
        { value: "one", name: "Model one" },
        { value: "two", name: "Model two" },
      ]}
      onChange={select}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Model" });
  expect(trigger).toHaveTextContent("Saved model");
  expect(select).not.toHaveBeenCalled();
  await user.click(trigger);
  expect(
    screen.queryByRole("menuitem", { name: "Saved model" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  await user.click(screen.getByRole("menuitem", { name: "Model two" }));
  expect(select).toHaveBeenCalledWith("two");
});
