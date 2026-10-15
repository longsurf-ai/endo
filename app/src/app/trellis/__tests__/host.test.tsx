// Purpose: Verify Endo completes and persists the copied one-step onboarding flow.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, useLocation } from "react-router";
import { RouterProvider } from "react-router/dom";
import { beforeEach, expect, test, vi } from "vitest";

import { OnboardingHost } from "../host";
import { useOnboardingProgress } from "../progress";
import type { OnboardingPageProps } from "../views";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

const transport = {} as AppTransport;
vi.mock(
  "@openchart/app/app/trellis/workflows/starter/connect-agents-page",
  () => ({
    ConnectAgentsPage: ({ transport: given, onDone }: OnboardingPageProps) => (
      <div role="dialog" aria-label="Connect your agent">
        {given === transport ? (
          <>
            <button onClick={onDone}>Continue</button>
            <button onClick={onDone}>Skip for now</button>
          </>
        ) : null}
      </div>
    ),
  }),
);

beforeEach(() => {
  useOnboardingProgress.setState({
    workflow: undefined,
    seen: [],
    started: [],
  });
});

function Page() {
  return <output aria-label="Page">{useLocation().pathname}</output>;
}

function mount(path = "/app") {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <Page />
            <Link to="/app/schedule">Schedule</Link>
            <OnboardingHost transport={transport} />
          </>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

test.each(["Continue", "Skip for now"])(
  "%s finishes onboarding on the current route and stays finished after rehydration",
  async (button) => {
    localStorage.setItem(
      "local:onboarding",
      JSON.stringify({
        state: { workflow: "starter" },
        version: 1,
      }),
    );
    await act(() => useOnboardingProgress.persist.rehydrate());
    const view = mount("/app/schedule");
    await screen.findByRole("dialog", { name: "Connect your agent" });
    await userEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Page" })).toHaveTextContent(
      "/app/schedule",
    );
    expect(useOnboardingProgress.getState()).toMatchObject({
      workflow: undefined,
      seen: [],
    });
    view.unmount();
    await act(() => useOnboardingProgress.persist.rehydrate());
    mount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

test("leaving the page completes the shown step", async () => {
  useOnboardingProgress.setState({ workflow: "starter" });
  mount();
  await screen.findByRole("dialog", { name: "Connect your agent" });
  await userEvent.click(screen.getByRole("link", { name: "Schedule" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(useOnboardingProgress.getState().workflow).toBeUndefined();
});

test("a workflow offered with startOnce is not offered again after completion", async () => {
  useOnboardingProgress.getState().startOnce("starter");
  mount();
  await userEvent.click(
    await screen.findByRole("button", { name: "Continue" }),
  );
  await act(() => useOnboardingProgress.persist.rehydrate());
  act(() => useOnboardingProgress.getState().startOnce("starter"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(useOnboardingProgress.getState().started).toEqual(["starter"]);
});

test("unknown saved workflows do not open onboarding", async () => {
  localStorage.setItem(
    "local:onboarding",
    JSON.stringify({
      state: { workflow: "retired", seen: [0] },
      version: 2,
    }),
  );
  await act(() => useOnboardingProgress.persist.rehydrate());
  mount();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(useOnboardingProgress.getState().workflow).toBeUndefined();
});
