// Purpose: Mount the shared application against one backend connection without development mocks.

import "@openchart/app/styles/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { bootstrapTheme } from "./lib/theme/theme";
import type { BackendConnection } from "./lib/transport/transport";
import type { AppHost } from "./lib/host/host";

/**
 * Mounts the application into its HTML root. Desktop supplies the backend
 * connection and native operations. Throws when the HTML root is missing.
 * @example bootstrap(connection, host);
 */
export function bootstrap(connection: BackendConnection, host: AppHost): void {
  const initialTheme = bootstrapTheme(connection);
  const root = document.getElementById("root");
  if (!root) throw new Error("App root is missing");
  createRoot(root).render(
    <StrictMode>
      <App connection={connection} initialTheme={initialTheme} host={host} />
    </StrictMode>,
  );
}
