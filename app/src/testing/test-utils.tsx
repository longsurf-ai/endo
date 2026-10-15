import type { ReactElement, PropsWithChildren } from "react";
import type { RenderOptions } from "@testing-library/react";
import { Toaster } from "@openchart/app/components/ui/sonner/sonner";
import type { AppHost } from "@openchart/app/lib/host/host";
// Purpose: Re-export Testing Library with the shared user-event helper for component tests.
import {
  screen,
  waitFor,
  within,
  render as rtlRender,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

export * from "@testing-library/react";
export { userEvent, rtlRender };

/** Find a visible error in the shared Sonner region; throws until a matching toast exists. @example getErrorToast("Offline"); */
export function getErrorToast(text?: string) {
  const region = screen.getByRole("region", { name: /Notifications/ });
  const errors = within(region)
    .getAllByRole("listitem")
    .filter(
      (item) =>
        item.getAttribute("data-type") === "error" &&
        item.getAttribute("data-removed") !== "true",
    );
  const error = text
    ? errors.find((item) => item.textContent?.includes(text))
    : errors.at(-1);
  if (!error) throw new Error("No error notification is visible");
  return error;
}
/** Wait for a matching error toast, failing on timeout. @example await findErrorToast("Offline"); */
export function findErrorToast(text?: string) {
  return waitFor(() => getErrorToast(text));
}

/** Mount AppProvider’s notification surface alongside a test view; Testing Library owns cleanup. @example renderWithToaster(<Settings />); */
export function renderWithToaster(ui: ReactElement, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  return rtlRender(ui, {
    ...options,
    wrapper: ({ children }: PropsWithChildren) => (
      <>
        <Toaster />
        {Wrapper ? <Wrapper>{children}</Wrapper> : children}
      </>
    ),
  });
}

/** A Desktop host with a cancelled folder picker and no changelog; override per test. @example <AppHostProvider value={testAppHost({ changelog })}> */
export function testAppHost(overrides: Partial<AppHost> = {}): AppHost {
  return {
    pickDirectory: async () => null,
    openPath: async () => {},
    revealPath: async () => {},
    changelog: [],
    enableNotifications: async () => {},
    onUpdateReady: () => () => {},
    restartToUpdate: async () => {},
    ...overrides,
  };
}
