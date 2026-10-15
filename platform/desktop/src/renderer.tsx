// Purpose: Open the shared app using the backend started by Electron main.
import type { BackendConnection } from "@openchart/app/lib/transport/transport";
import changelog from "./changelog/changelog.json";
import "./renderer.css";

declare global {
  interface Window {
    /** Added by preload.ts to supply the connection, folder picker and notification opt-in. */
    readonly desktop: {
      readonly connection: () => Promise<BackendConnection>;
      readonly pickDirectory: () => Promise<string | null>;
      readonly openPath: (path: string) => Promise<void>;
      readonly revealPath: (path: string) => Promise<void>;
      readonly onUpdateReady: (
        listener: (release: string) => void,
      ) => () => void;
      readonly restartToUpdate: () => Promise<void>;
      readonly enableNotifications: () => Promise<void>;
    };
  }
}

// Only Mac desktop pages need to leave room for the system's window buttons.
if (navigator.platform.startsWith("Mac"))
  document.documentElement.classList.add("desktop-macos");

// Get the connection details before rendering; the page then calls the backend directly.
void window.desktop.connection().then(async (connection) => {
  const { bootstrap } = await import("@openchart/app/bootstrap");
  bootstrap(connection, {
    pickDirectory: () => window.desktop.pickDirectory(),
    openPath: (path) => window.desktop.openPath(path),
    revealPath: (path) => window.desktop.revealPath(path),
    onUpdateReady: (listener) => window.desktop.onUpdateReady(listener),
    restartToUpdate: () => window.desktop.restartToUpdate(),
    changelog,
    enableNotifications: () => window.desktop.enableNotifications(),
  });
});
