// Purpose: Preserve button semantics when compact controls compose links and icons.
import PlusSignIcon from "@hugeicons/core-free-icons/PlusSignIcon";
import { render, screen } from "@testing-library/react";

import { Button } from "@openchart/app/components/ui/button/button";
import { Icon } from "@openchart/app/components/ui/icon";

test("asChild puts control styling and optional adornments on the actual link", () => {
  render(
    <Button asChild variant="outline" icon={<Icon icon={PlusSignIcon} />}>
      <a href="#destination">Open destination</a>
    </Button>,
  );

  const link = screen.getByRole("link", { name: "Open destination" });
  expect(link).toHaveAttribute("href", "#destination");
  expect(link).toHaveClass("h-9");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
