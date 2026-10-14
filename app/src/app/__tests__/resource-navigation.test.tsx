import { expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Link, Outlet, useParams } from "react-router";
import { RouterProvider } from "react-router/dom";
import { useContext, useEffect } from "react";
import {
  resourceDestinations,
  ResourceNavigationProvider,
} from "@openchart/app/app/resource-navigation";
import { ResourceDestinationContext } from "@openchart/app/lib/resource/navigation";
import {
  UnsavedChangesProvider,
  useUnsavedChanges,
} from "@openchart/app/lib/unsaved-changes/unsaved-changes";

it("derives unvisited destinations through nested and pathless routes, encoding IDs once", () => {
  const lazy = vi.fn();
  const routes = [
    {
      path: "/app",
      children: [
        {
          children: [
            {
              path: "dashboards/:dashboardId",
              handle: {
                resource: { name: "dashboard", idParam: "dashboardId" },
              },
              lazy,
            },
            {
              path: "/app/alerts/rules/:ruleId",
              handle: { resource: { name: "alert_rule", idParam: "ruleId" } },
            },
            { path: "workspaces" },
          ],
        },
      ],
    },
  ];
  const destination = resourceDestinations(routes);
  expect(destination("dashboard", "dsh_a/b?#%€")).toBe(
    "/app/dashboards/dsh_a%2Fb%3F%23%25%E2%82%AC",
  );
  expect(destination("alert_rule", "alr_one")).toBe(
    "/app/alerts/rules/alr_one",
  );
  expect(destination("trigger", "trg_one")).toBeUndefined();
  expect(destination("workspace", "wsp_one")).toBeUndefined();
  expect(destination("dashboard", "")).toBeUndefined();
  expect(lazy).not.toHaveBeenCalled();
});

it("rejects ambiguous canonical routes", () => {
  const route = {
    path: "/:id",
    handle: { resource: { name: "dashboard", idParam: "id" } },
  };
  expect(() => resourceDestinations([route, route])).toThrow(
    "Multiple routes for Resource dashboard",
  );
});

function Draft() {
  const changes = useUnsavedChanges();
  const destination = useContext(ResourceDestinationContext);
  useEffect(() => changes?.register("draft", () => true), [changes]);
  return <Link to={destination("alert_rule", "alr_one")!}>Price alert</Link>;
}

function Rule() {
  const { ruleId } = useParams();
  return <h1>{ruleId}</h1>;
}

it("uses normal router navigation and retains the shell's unsaved-draft guard", async () => {
  const user = userEvent.setup();
  const router = createMemoryRouter(
    [
      {
        path: "/app",
        element: (
          <UnsavedChangesProvider>
            <Outlet />
          </UnsavedChangesProvider>
        ),
        children: [
          { path: "draft", element: <Draft /> },
          {
            path: "alerts/:ruleId",
            handle: { resource: { name: "alert_rule", idParam: "ruleId" } },
            element: <Rule />,
          },
        ],
      },
    ],
    { initialEntries: ["/app/draft"] },
  );
  render(
    <ResourceNavigationProvider routes={router.routes}>
      <RouterProvider router={router} />
    </ResourceNavigationProvider>,
  );
  await user.click(screen.getByRole("link", { name: "Price alert" }));
  expect(await screen.findByRole("dialog")).toHaveTextContent(
    "Discard unsaved changes?",
  );
  expect(router.state.location.pathname).toBe("/app/draft");
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(router.state.location.pathname).toBe("/app/draft");
  await user.click(screen.getByRole("link", { name: "Price alert" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(await screen.findByRole("heading", { name: "alr_one" })).toBeVisible();
  router.dispose();
});
