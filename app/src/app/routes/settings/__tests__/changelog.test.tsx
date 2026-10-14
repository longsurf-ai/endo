// Purpose: Verify Settings lists Desktop's bundled releases in order with their calendar dates.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";

import { CopilotControlsProvider } from "@openchart/app/app/agent/copilot-controls";
import ChangelogSettings from "@openchart/app/app/routes/settings/changelog";
import { SidebarProvider } from "@openchart/app/components/ui/sidebar";
import { AppHostProvider } from "@openchart/app/lib/host/host";
import { testAppHost } from "@openchart/app/testing/test-utils";

test("releases appear newest first on their release day", () => {
  const changelog = [
    {
      version: "0.1.6",
      date: "2026-10-01",
      items: ["Updates wait in the sidebar until you restart."],
    },
    { version: "0.1.5", date: "2026-09-23", items: ["Fixed a dark band."] },
  ];
  render(
    <MemoryRouter initialEntries={["/app/settings/changelog"]}>
      <AppHostProvider value={testAppHost({ changelog })}>
        <SidebarProvider>
          <CopilotControlsProvider value={null}>
            <ChangelogSettings />
          </CopilotControlsProvider>
        </SidebarProvider>
      </AppHostProvider>
    </MemoryRouter>,
  );
  expect(screen.getByRole("link", { name: "Changelog" })).toHaveClass("active");
  expect(
    screen.getAllByText(/^0\.1\.\d$/).map((badge) => badge.textContent),
  ).toEqual(["0.1.6", "0.1.5"]);
  // A date-only value is UTC midnight; a local format would show Sep 30 here.
  expect(screen.getByText("Oct 1, 2026")).toHaveAttribute(
    "dateTime",
    "2026-10-01",
  );
  expect(
    screen.getByText("Updates wait in the sidebar until you restart."),
  ).toBeVisible();
});
