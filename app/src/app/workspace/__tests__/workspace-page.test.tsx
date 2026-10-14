// Purpose: Workspace navigation keeps its keyboard action inside the shared file-search command.
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@openchart/app/components/ui/command";
import { WorkspacePage } from "@openchart/app/app/workspace/workspace-page";

const controls = vi.hoisted(() => ({ toggle: vi.fn(), openFile: vi.fn() }));
vi.mock("react-router", () => ({
  useOutletContext: () => ({ transport: {} }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("@openchart/app/components/ui/sidebar", () => ({
  useSidebar: () => ({
    open: false,
    isMobile: false,
    toggleSidebar: controls.toggle,
  }),
}));
vi.mock("@openchart/app/app/agent/copilot-controls", () => ({
  CopilotTrigger: () => null,
}));
vi.mock("@openchart/app/features/workspace/components/workspace-view", () => ({
  WorkspaceView: ({ navigation }: { navigation: ReactNode }) => (
    <Command label="Search files">
      {navigation}
      <CommandInput />
      <CommandList>
        <CommandItem onSelect={controls.openFile}>matching.tea</CommandItem>
      </CommandList>
    </Command>
  ),
}));
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

test("Enter on navigation never selects a matching file, while search Enter still does", async () => {
  const user = userEvent.setup();
  render(<WorkspacePage />);
  const search = screen.getByRole("combobox", { name: "Search files" });
  await user.type(search, "matching");
  expect(screen.getByRole("option")).toHaveTextContent("matching.tea");
  await user.tab({ shift: true });
  expect(
    screen.getByRole("button", { name: "Toggle navigation" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(controls.toggle).toHaveBeenCalledOnce();
  expect(controls.openFile).not.toHaveBeenCalled();
  await user.tab();
  expect(search).toHaveFocus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(controls.openFile).toHaveBeenCalledOnce();
});
