// Purpose: Expose the backend connection, native folder picker and notification opt-in through guarded main IPC.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

// Electron runs this before page scripts. Expose only these narrow host operations.
contextBridge.exposeInMainWorld("desktop", {
  /** Asks main for the address and secret; main checks which page is asking. */
  connection: () => ipcRenderer.invoke("desktop.connection"),
  /** Opens main's native single-folder picker. */
  pickDirectory: () => ipcRenderer.invoke("desktop.pickDirectory"),
  /** Opens a local file with the system's default application. */
  openPath: (path: string) => ipcRenderer.invoke("desktop.openPath", path),
  revealPath: (path: string) => ipcRenderer.invoke("desktop.revealPath", path),
  /** Reports the downloaded release; disposal also suppresses a pending snapshot. */
  onUpdateReady: (listener: (release: string) => void) => {
    let active = true;
    let announced = false;
    const receive = (_event: IpcRendererEvent, release: string) => {
      announced = true;
      if (active) listener(release);
    };
    ipcRenderer.on("desktop.updateReady", receive);
    void ipcRenderer.invoke("desktop.updateReady").then(
      (release: string | null) => {
        if (active && !announced && release) listener(release);
      },
      (error: unknown) => console.error("Could not read desktop update", error),
    );
    return () => {
      active = false;
      ipcRenderer.removeListener("desktop.updateReady", receive);
    };
  },
  /** Requests normal shutdown followed by installation; failures reject. */
  restartToUpdate: () => ipcRenderer.invoke("desktop.restartToUpdate"),
  /** Asks main to show the notification that lets macOS ask for permission. */
  enableNotifications: () => ipcRenderer.invoke("desktop.enableNotifications"),
});
