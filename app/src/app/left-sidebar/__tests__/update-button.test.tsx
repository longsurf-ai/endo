// Purpose: Verify the sidebar offers a restart only after Desktop reports a downloaded update.
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";

import {
  UpdateButton,
  useUpdateReady,
} from "@openchart/app/app/left-sidebar/update-button";
import {
  SidebarMenu,
  SidebarMenuItem,
  SidebarProvider,
} from "@openchart/app/components/ui/sidebar";
import { AppHostProvider } from "@openchart/app/lib/host/host";
import { testAppHost } from "@openchart/app/testing/test-utils";

test("an update is ready only once Desktop announces it, and unsubscribes with its owner", () => {
  let announce: (release: string) => void = () => {};
  const unsubscribe = vi.fn();
  const host = testAppHost({
    onUpdateReady: (listener) => {
      announce = listener;
      return unsubscribe;
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AppHostProvider value={host}>{children}</AppHostProvider>
  );
  const view = renderHook(useUpdateReady, { wrapper });
  expect(view.result.current).toBeUndefined();
  act(() => announce("Endo 0.1.6"));
  expect(view.result.current).toBe("Endo 0.1.6");
  view.unmount();
  expect(unsubscribe).toHaveBeenCalled();
});

test("the update button names its release and asks Desktop to restart", async () => {
  const restartToUpdate = vi.fn(async () => {});
  render(
    <AppHostProvider value={testAppHost({ restartToUpdate })}>
      <SidebarProvider>
        <SidebarMenu>
          <SidebarMenuItem>
            <UpdateButton release="Endo 0.1.6" />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarProvider>
    </AppHostProvider>,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Restart to install Endo 0.1.6" }),
  );
  expect(restartToUpdate).toHaveBeenCalledOnce();
});
