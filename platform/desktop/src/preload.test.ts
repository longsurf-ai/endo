// Purpose: Keep update subscriptions scoped to their renderer and recover downloads without stale callbacks.
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";

async function bridge() {
  vi.resetModules();
  let resolve!: (release: string | null) => void;
  let reject!: (error: Error) => void;
  const snapshot = new Promise<string | null>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const ipc = Object.assign(new EventEmitter(), {
    invoke: vi.fn(() => snapshot),
  });
  const exposeInMainWorld = vi.fn();
  vi.doMock("electron", () => ({
    contextBridge: { exposeInMainWorld },
    ipcRenderer: ipc,
  }));
  await import("./preload");
  const desktop = exposeInMainWorld.mock.calls[0]![1] as {
    onUpdateReady: (listener: (release: string) => void) => () => void;
    restartToUpdate: () => Promise<void>;
  };
  return { desktop, ipc, resolve, reject, snapshot };
}

test("a newly opened page recovers the downloaded release and disposes its listener", async () => {
  const { desktop, ipc, resolve, snapshot } = await bridge();
  const listener = vi.fn();
  const dispose = desktop.onUpdateReady(listener);
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith("desktop.updateReady");
  resolve("Endo 0.1.2");
  await snapshot;
  expect(listener).toHaveBeenCalledExactlyOnceWith("Endo 0.1.2");
  dispose();
  expect(ipc.listenerCount("desktop.updateReady")).toBe(0);
});

test("a live update wins over a pending snapshot", async () => {
  const { desktop, ipc, resolve, snapshot } = await bridge();
  const listener = vi.fn();
  const dispose = desktop.onUpdateReady(listener);
  ipc.emit("desktop.updateReady", {}, "Endo 0.1.3");
  resolve("Endo 0.1.2");
  await snapshot;
  expect(listener).toHaveBeenCalledExactlyOnceWith("Endo 0.1.3");
  dispose();
});

test("disposal suppresses a pending snapshot and later events", async () => {
  const { desktop, ipc, resolve, snapshot } = await bridge();
  const listener = vi.fn();
  desktop.onUpdateReady(listener)();
  resolve("Endo 0.1.2");
  await snapshot;
  ipc.emit("desktop.updateReady", {}, "Endo 0.1.3");
  expect(listener).not.toHaveBeenCalled();
});

test("a failed snapshot is reported without inventing a ready update", async () => {
  const { desktop, reject, snapshot } = await bridge();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const listener = vi.fn();
    const dispose = desktop.onUpdateReady(listener);
    const failure = new Error("IPC unavailable");
    reject(failure);
    await expect(snapshot).rejects.toThrow("IPC unavailable");
    expect(error).toHaveBeenCalledWith(
      "Could not read desktop update",
      failure,
    );
    expect(listener).not.toHaveBeenCalled();
    dispose();
  } finally {
    error.mockRestore();
  }
});
