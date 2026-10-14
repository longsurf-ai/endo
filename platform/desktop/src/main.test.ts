// Purpose: Verify Electron main never bypasses backend shutdown, resumes startup after Quit, or mishandles backend notifications.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import type { Notify } from "./host-protocol";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

let cleanup = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

async function host({
  production = false,
  devUrl = "http://127.0.0.1:5173",
}: { production?: boolean; devUrl?: string } = {}) {
  vi.resetModules();
  const resourcesPath = Object.getOwnPropertyDescriptor(
    process,
    "resourcesPath",
  );
  Object.defineProperty(process, "resourcesPath", {
    value: "/app/Contents/Resources",
    configurable: true,
  });
  vi.stubEnv("REAGENT_DESKTOP_DEV_URL", devUrl);
  vi.stubEnv(
    "REAGENT_DESKTOP_BUILD",
    production ? "production" : "development",
  );
  const signals = (["SIGINT", "SIGTERM"] as const).map((signal) => ({
    signal,
    listeners: process.listeners(signal),
  }));
  cleanup = () => {
    if (resourcesPath)
      Object.defineProperty(process, "resourcesPath", resourcesPath);
    else Reflect.deleteProperty(process, "resourcesPath");
    for (const { signal, listeners } of signals)
      for (const listener of process.listeners(signal))
        if (!listeners.includes(listener))
          process.removeListener(signal, listener);
  };
  const ready = deferred<number>();
  const stopped = deferred<void>();
  const stop = vi.fn(() => stopped.promise);
  const startBackend = vi.fn<
    (input: { onNotify: (notification: Notify) => void }) => {
      ready: Promise<number>;
      stop: () => Promise<void>;
    }
  >(() => ({ ready: ready.promise, stop }));
  const opened = vi.fn();
  const windows: Window[] = [];
  class Window extends EventEmitter {
    static getAllWindows() {
      return windows;
    }
    static fromWebContents(contents: unknown) {
      return windows.find((window) => window.webContents === contents) ?? null;
    }
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      mainFrame: { url: "http://127.0.0.1:5173/app" },
    });
    readonly loadURL = vi.fn(async () => {});
    readonly show = vi.fn();
    readonly isMinimized = vi.fn(() => true);
    readonly restore = vi.fn();
    readonly focus = vi.fn();
    constructor() {
      super();
      windows.push(this);
      opened();
    }
  }
  const notifications: SystemNotification[] = [];
  const notificationsSupported = vi.fn(() => true);
  class SystemNotification extends EventEmitter {
    static isSupported = notificationsSupported;
    readonly show = vi.fn();
    readonly options: unknown;
    constructor(options: unknown) {
      super();
      this.options = options;
      notifications.push(this);
    }
  }
  const home = temporaryHome();
  const app = Object.assign(new EventEmitter(), {
    commandLine: {
      getSwitchValue: () => home,
    },
    isPackaged: true,
    setName: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    getPath: () => "/profile",
    getAppPath: () => "/app",
    quit: vi.fn(),
    exit: vi.fn(),
  });
  const showErrorBox = vi.fn();
  const showMessageBox = vi.fn(async () => ({ response: 0 }));
  const showMessageBoxSync = vi.fn(() => 0);
  const showOpenDialog = vi.fn(async () => ({
    canceled: false,
    filePaths: ["/chosen/folder"],
  }));
  const handle = vi.fn();
  const setPermissionRequestHandler = vi.fn();
  const openPath = vi.fn(async () => "");
  const showItemInFolder = vi.fn();
  const openExternal = vi.fn(async () => {});
  vi.doMock("electron", () => ({
    app,
    BrowserWindow: Window,
    dialog: {
      showErrorBox,
      showMessageBoxSync,
      showMessageBox,
      showOpenDialog,
    },
    ipcMain: { handle },
    net: {},
    Notification: SystemNotification,
    session: {
      defaultSession: {
        protocol: { handle: vi.fn() },
        setPermissionRequestHandler,
        setPermissionCheckHandler: vi.fn(),
      },
    },
    shell: { openPath, openExternal, showItemInFolder },
    protocol: { registerSchemesAsPrivileged: vi.fn() },
  }));
  vi.doMock("./backend-process", () => ({ startBackend }));
  await import("./main");
  return {
    app,
    ready,
    stopped,
    stop,
    startBackend,
    opened,
    showErrorBox,
    showMessageBoxSync,
    windows,
    notifications,
    notificationsSupported,
    showOpenDialog,
    handle,
    setPermissionRequestHandler,
    openPath,
    showItemInFolder,
    openExternal,
    showMessageBox,
  };
}

test("development opens the app root and hands the backend only this run's paths", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  expect(runtime.windows[0]!.loadURL).toHaveBeenCalledWith(
    "http://127.0.0.1:5173/app",
  );
  const [{ init }] = runtime.startBackend.mock.calls[0]! as unknown as [
    { init: Record<string, unknown> },
  ];
  expect(Object.keys(init).sort()).toEqual([
    "home",
    "rendererOrigin",
    "token",
    "type",
  ]);
  expect(init.rendererOrigin).toBe("http://127.0.0.1:5173");
});

test("development startup failures exit visibly without a pre-ready native dialog", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const runtime = await host({ devUrl: "https://example.com" });
    expect(error).toHaveBeenCalledWith(
      new Error("Desktop development requires an HTTP loopback URL"),
    );
    expect(runtime.app.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.showErrorBox).not.toHaveBeenCalled();
    expect(runtime.startBackend).not.toHaveBeenCalled();
    expect(runtime.opened).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});

test("native picker selects one directory, handles cancellation, and rejects untrusted frames", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  const pick = runtime.handle.mock.calls.find(
    ([channel]) => channel === "desktop.pickDirectory",
  )![1];
  const window = runtime.windows[0]!;
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  await expect(pick(event)).resolves.toBe("/chosen/folder");
  expect(runtime.showOpenDialog).toHaveBeenCalledWith(
    window,
    expect.objectContaining({
      properties: ["openDirectory"],
    }),
  );
  runtime.showOpenDialog.mockResolvedValueOnce({
    canceled: true,
    filePaths: [],
  });
  await expect(pick(event)).resolves.toBeNull();
  runtime.showOpenDialog.mockClear();
  await expect(pick({ ...event, senderFrame: null })).rejects.toThrow(
    "untrusted frame",
  );
  await expect(
    pick({ ...event, senderFrame: { url: event.senderFrame.url } }),
  ).rejects.toThrow("untrusted frame");
  window.webContents.mainFrame.url = "https://untrusted.example/app";
  await expect(pick(event)).rejects.toThrow("untrusted frame");
  expect(runtime.showOpenDialog).not.toHaveBeenCalled();
});

test("native file open validates local paths and the calling frame, and propagates OS failures", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  const open = runtime.handle.mock.calls.find(
    ([channel]) => channel === "desktop.openPath",
  )![1];
  const window = runtime.windows[0]!;
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  await expect(open(event, "/other/€ note.pdf")).resolves.toBeUndefined();
  expect(runtime.openPath).toHaveBeenCalledExactlyOnceWith("/other/€ note.pdf");
  runtime.openPath.mockResolvedValueOnce("File not found");
  await expect(open(event, "/other/missing.pdf")).rejects.toThrow(
    "File not found",
  );
  runtime.openPath.mockClear();
  for (const path of [
    null,
    42,
    "",
    "relative.pdf",
    "file:///other/note.pdf",
    "https://example.com",
    "//remote/file.pdf",
    "/other/bad\0.pdf",
  ])
    await expect(open(event, path)).rejects.toThrow();
  await expect(
    open({ ...event, senderFrame: null }, "/other/note.pdf"),
  ).rejects.toThrow("untrusted frame");
  await expect(
    open(
      { ...event, senderFrame: { url: event.senderFrame.url } },
      "/other/note.pdf",
    ),
  ).rejects.toThrow("untrusted frame");
  window.webContents.mainFrame.url = "https://untrusted.example/app";
  await expect(open(event, "/other/note.pdf")).rejects.toThrow(
    "untrusted frame",
  );
  expect(runtime.openPath).not.toHaveBeenCalled();
});

test("revealing a file validates the path and calling frame like opening", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  const reveal = runtime.handle.mock.calls.find(
    ([channel]) => channel === "desktop.revealPath",
  )![1];
  const window = runtime.windows[0]!;
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  await reveal(event, "/other/€ note.pdf");
  expect(runtime.showItemInFolder).toHaveBeenCalledExactlyOnceWith(
    "/other/€ note.pdf",
  );
  runtime.showItemInFolder.mockClear();
  for (const path of ["relative.pdf", "file:///other/note.pdf", "//remote/x"])
    await expect(reveal(event, path)).rejects.toThrow();
  await expect(
    reveal({ ...event, senderFrame: null }, "/other/note.pdf"),
  ).rejects.toThrow("untrusted frame");
  expect(runtime.showItemInFolder).not.toHaveBeenCalled();
});

test("pages may write to the clipboard and get no other permission", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  const [decide] = runtime.setPermissionRequestHandler.mock.calls[0]!;
  const granted = (permission: string) => {
    const callback = vi.fn();
    decide({}, permission, callback);
    return callback.mock.calls[0]![0];
  };
  expect(granted("clipboard-sanitized-write")).toBe(true);
  expect(granted("clipboard-read")).toBe(false);
  expect(granted("media")).toBe(false);
});

test("a backend notification is shown and its click brings the window forward", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  const { onNotify } = runtime.startBackend.mock.calls[0]![0];
  onNotify({
    type: "notify",
    title: "BTC breakout",
    body: "exceeded 70000",
    sound: "glass",
  });
  expect(runtime.notifications).toHaveLength(1);
  const notification = runtime.notifications[0]!;
  // The protocol tag stays out of what Electron is asked to display.
  expect(notification.options).toEqual({
    title: "BTC breakout",
    body: "exceeded 70000",
    silent: false,
    ...(process.platform === "darwin" ? { sound: "openchart-glass.wav" } : {}),
  });
  expect(notification.show).toHaveBeenCalledOnce();
  const window = runtime.windows[0]!;
  expect(window.focus).not.toHaveBeenCalled();
  notification.emit("click");
  expect(window.restore).toHaveBeenCalledOnce();
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  // restore() would un-maximize a window that is not minimized.
  window.isMinimized.mockReturnValue(false);
  notification.emit("click");
  expect(window.restore).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledTimes(2);
  // A click after the user closed the window must not throw.
  runtime.windows.length = 0;
  onNotify({ type: "notify", title: "ETH breakout", body: "", sound: "none" });
  expect(runtime.notifications[1]!.options).toMatchObject({ silent: true });
  expect(() => runtime.notifications[1]!.emit("click")).not.toThrow();
  runtime.notificationsSupported.mockReturnValue(false);
  onNotify({ type: "notify", title: "Unsupported", body: "", sound: "system" });
  expect(runtime.notifications).toHaveLength(2);
});

test("turning notifications on shows one so macOS can ask, only for the app's own page", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  const enable = runtime.handle.mock.calls.find(
    ([channel]) => channel === "desktop.enableNotifications",
  )![1];
  const window = runtime.windows[0]!;
  const event = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  enable(event);
  expect(runtime.notifications).toHaveLength(1);
  expect(runtime.notifications[0]!.options).toEqual({
    title: "Notifications are on",
    body: "Reagent will notify you here when scheduled work needs you.",
    silent: false,
  });
  expect(runtime.notifications[0]!.show).toHaveBeenCalledOnce();
  expect(() => enable({ ...event, senderFrame: null })).toThrow(
    "untrusted frame",
  );
  expect(runtime.notifications).toHaveLength(1);
});

test("Quit during startup never starts a backend or window", async () => {
  const runtime = await host();
  const event = { preventDefault: vi.fn() };
  runtime.app.emit("before-quit", event);
  await vi.waitFor(() => expect(runtime.app.quit).toHaveBeenCalledOnce());
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(runtime.startBackend).not.toHaveBeenCalled();
  expect(runtime.opened).not.toHaveBeenCalled();
  expect(runtime.showErrorBox).not.toHaveBeenCalled();
});

test.each([false, true])(
  "repeated Quit waits for stop and prevents windows (already ready: %s)",
  async (alreadyReady) => {
    const runtime = await host();
    await vi.waitFor(() => expect(runtime.startBackend).toHaveBeenCalledOnce());
    if (alreadyReady) {
      runtime.ready.resolve(4321);
      await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
    }
    const event = { preventDefault: vi.fn() };
    runtime.app.emit("before-quit", event);
    runtime.app.emit("before-quit", event);
    if (alreadyReady) {
      expect(runtime.stop).not.toHaveBeenCalled();
      runtime.windows.length = 0;
      runtime.app.emit("will-quit", event);
      runtime.app.emit("will-quit", event);
    }
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(runtime.app.quit).not.toHaveBeenCalled();
    runtime.ready.resolve(4321);
    await runtime.ready.promise;
    runtime.app.emit("activate");
    expect(runtime.opened).toHaveBeenCalledTimes(alreadyReady ? 1 : 0);
    expect(runtime.app.quit).not.toHaveBeenCalled();
    runtime.stopped.resolve();
    await vi.waitFor(() => expect(runtime.app.quit).toHaveBeenCalledOnce());
    expect(runtime.app.listenerCount("before-quit")).toBe(0);
    expect(runtime.showErrorBox).not.toHaveBeenCalled();
  },
);

test("canceling an unsaved editor's close keeps the backend available for saving", async () => {
  const runtime = await host();
  runtime.ready.resolve(4321);
  await vi.waitFor(() => expect(runtime.opened).toHaveBeenCalledOnce());
  runtime.app.emit("before-quit", { preventDefault: vi.fn() });
  const event = { preventDefault: vi.fn() };
  runtime.windows[0]!.webContents.emit("will-prevent-unload", event);
  expect(runtime.showMessageBoxSync).toHaveBeenCalledOnce();
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(runtime.stop).not.toHaveBeenCalled();
  runtime.showMessageBoxSync.mockReturnValue(1);
  runtime.windows[0]!.webContents.emit("will-prevent-unload", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
});
