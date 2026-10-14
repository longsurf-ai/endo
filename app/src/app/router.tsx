// Purpose: Route product pages inside the persistent application layout.
import { useState } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";

import type { Theme } from "@openchart/app/lib/theme/theme";
import type { BackendConnection } from "@openchart/app/lib/transport/transport";

import { AppLayout } from "./layout";
import { ResourceNavigationProvider } from "./resource-navigation";

/** Create one router for an application mount. @example const router = createAppRouter(connection); */
export const createAppRouter = (
  connection: BackendConnection,
  initialTheme: Theme = "system",
) =>
  createBrowserRouter([
    { path: "/", element: <Navigate to="/app" replace /> },
    {
      path: "/app",
      element: (
        <AppLayout connection={connection} initialTheme={initialTheme} />
      ),
      hydrateFallbackElement: <p role="status">Opening workspace…</p>,
      children: [
        {
          path: "schedule/:view?",
          lazy: async () => ({
            Component: (
              await import("@openchart/app/app/schedule/schedule-page")
            ).SchedulePage,
          }),
        },
        {
          path: "workspaces",
          lazy: async () => ({
            Component: (await import("./workspace/workspace-page"))
              .WorkspacePage,
          }),
        },
        {
          index: true,
          lazy: async () => ({
            Component: (
              await import("@openchart/app/app/agent/full-page-agent")
            ).FullPageAgent,
          }),
        },
        {
          path: "sessions/:sessionId",
          lazy: async () => ({
            Component: (
              await import("@openchart/app/app/agent/full-page-agent")
            ).FullPageAgent,
          }),
        },
        {
          path: "settings/interface",
          lazy: async () => ({
            Component: (await import("./routes/settings/interface")).default,
          }),
        },
        {
          path: "settings/models",
          lazy: async () => ({
            Component: (await import("./routes/settings/models")).default,
          }),
        },
        {
          path: "settings/changelog",
          lazy: async () => ({
            Component: (await import("./routes/settings/changelog")).default,
          }),
        },
      ],
    },
    {
      path: "*",
      lazy: async () => ({
        Component: (await import("./routes/not-found")).default,
      }),
    },
  ]);

/** Keep route transitions synchronous with external-store subscriptions. @example <AppRouter connection={connection} /> */
export const AppRouter = ({
  connection,
  initialTheme = "system",
}: {
  connection: BackendConnection;
  initialTheme?: Theme;
}) => {
  const [router] = useState(() => createAppRouter(connection, initialTheme));
  return (
    <ResourceNavigationProvider routes={router.routes}>
      <RouterProvider router={router} useTransitions={false} />
    </ResourceNavigationProvider>
  );
};
