// Purpose: Expose the backend connection, native folder picker and notification opt-in through guarded main IPC.

import { contextBridge, ipcRenderer } from "electron";

// Electron runs this before page scripts. Expose only these narrow host operations.
contextBridge.exposeInMainWorld("desktop", {
  /** Asks main for the address and secret; main checks which page is asking. */
  connection: () => ipcRenderer.invoke("desktop.connection"),
  /** Opens main's native single-folder picker. */
  pickDirectory: () => ipcRenderer.invoke("desktop.pickDirectory"),
  /** Opens a local file with the system's default application. */
  openPath: (path: string) => ipcRenderer.invoke("desktop.openPath", path),
  revealPath: (path: string) => ipcRenderer.invoke("desktop.revealPath", path),
  /** Asks main to show the notification that lets macOS ask for permission. */
  enableNotifications: () => ipcRenderer.invoke("desktop.enableNotifications"),
});
