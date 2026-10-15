// Purpose: Verify the sidebar offers chat, schedule, workspace and settings navigation beside the conversation list.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

import { LeftSidebar } from "@openchart/app/app/left-sidebar";
import { SidebarProvider } from "@openchart/app/components/ui/sidebar";
import { AppHostProvider } from "@openchart/app/lib/host/host";
import { testAppHost } from "@openchart/app/testing/test-utils";

// The conversation list has its own tests.
vi.mock("@openchart/app/app/left-sidebar/nav-chats", () => ({
  NavChats: () => null,
}));

test("the sidebar links to every application section", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const onCreateChat = vi.fn();
  render(
    <MemoryRouter>
      <AppHostProvider value={testAppHost()}>
        <SidebarProvider>
          <LeftSidebar chats={{} as never} onCreateChat={onCreateChat} />
        </SidebarProvider>
      </AppHostProvider>
    </MemoryRouter>,
  );
  screen.getByRole("button", { name: /New Chat/ }).click();
  expect(onCreateChat).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "Schedule" })).toHaveAttribute(
    "href",
    "/app/schedule",
  );
  expect(screen.getByRole("link", { name: "Workspace" })).toHaveAttribute(
    "href",
    "/app/workspaces",
  );
  expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
    "href",
    "/app/settings/interface",
  );
  vi.unstubAllGlobals();
});
