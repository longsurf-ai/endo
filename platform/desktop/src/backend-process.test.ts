// Purpose: Verify backend supervision states with a fake utility process instead of Electron.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

class FakeChild extends EventEmitter {
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}
const fake = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock("electron", () => ({
  utilityProcess: { fork: vi.fn(() => fake.child) },
}));
import { startBackend } from "./backend-process";

const init = {
  type: "init" as const,
  token: "token",
  home: "/profile",
  rendererOrigin: "endo://app",
};
let child: FakeChild;
const onExit = vi.fn();
const onNotify = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  child = new FakeChild();
  fake.child = child;
  onExit.mockReset();
  onNotify.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function start() {
  return startBackend({
    modulePath: "/bundle/backend.js",
    init,
    onExit,
    onNotify,
  });
}

test("posts init immediately and resolves with the ready port", async () => {
  const backend = start();
  expect(child.postMessage).toHaveBeenCalledWith(init);
  child.emit("message", { type: "ready", port: 4321 });
  expect(await backend.ready).toBe(4321);
  expect(child.kill).not.toHaveBeenCalled();
});

test("kills and rejects when the child exits before ready", async () => {
  const backend = start();
  child.emit("exit", 3);
  await expect(backend.ready).rejects.toThrow("exited during startup (3)");
  expect(child.kill).toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
});

test("kills and rejects when ready never arrives within 30 s", async () => {
  const backend = start();
  const rejected = expect(backend.ready).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(child.kill).toHaveBeenCalled();
  child.emit("exit", 137);
  await rejected;
});

test("stop posts shutdown and resolves only on exit, killing after 5 s", async () => {
  const backend = start();
  child.emit("message", { type: "ready", port: 1 });
  await backend.ready;
  const stopped = backend.stop();
  expect(child.postMessage).toHaveBeenLastCalledWith({ type: "shutdown" });
  let resolved = false;
  void stopped.then(() => (resolved = true));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(child.kill).toHaveBeenCalled();
  expect(resolved).toBe(false);
  child.emit("exit", 0);
  await stopped;
  expect(onExit).not.toHaveBeenCalled();
});

test("reports an exit after ready that stop did not request", async () => {
  const backend = start();
  child.emit("message", { type: "ready", port: 1 });
  await backend.ready;
  child.emit("exit", 137);
  await vi.advanceTimersByTimeAsync(0);
  expect(onExit).toHaveBeenCalledWith(137);
});

test("stop during startup uses the 5 s deadline and waits for exit", async () => {
  const backend = start();
  const rejected = expect(backend.ready).rejects.toThrow(
    "exited during startup",
  );
  const stopped = backend.stop();
  expect(child.postMessage).toHaveBeenLastCalledWith({ type: "shutdown" });
  expect(backend.stop()).toBe(stopped);
  expect(child.postMessage).toHaveBeenCalledTimes(2);
  let resolved = false;
  void stopped.then(() => (resolved = true));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(resolved).toBe(false);
  child.emit("exit", 137);
  await Promise.all([stopped, rejected]);
  expect(onExit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("ready while stopping never reports the requested exit as a crash", async () => {
  const backend = start();
  const stopped = backend.stop();
  child.emit("message", { type: "ready", port: 4321 });
  expect(await backend.ready).toBe(4321);
  child.emit("exit", 0);
  await stopped;
  expect(onExit).not.toHaveBeenCalled();
});

test("invalid readiness kills the child and rejects only after exit", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const backend = start();
  const rejected = expect(backend.ready).rejects.toThrow(
    "Unexpected backend message",
  );
  child.emit("message", { type: "ready", port: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(child.kill).toHaveBeenCalledOnce();
  child.emit("exit", 137);
  await rejected;
  expect(onExit).not.toHaveBeenCalled();
});

test("delivers parsed notifications before and after ready", async () => {
  const backend = start();
  const early = {
    type: "notify",
    title: "Early",
    body: "before ready",
    sound: "chime",
  };
  const late = { type: "notify", title: "Late", body: "", sound: "none" };
  // A notification that precedes ready must not fail startup.
  child.emit("message", early);
  child.emit("message", { type: "ready", port: 4321 });
  expect(await backend.ready).toBe(4321);
  child.emit("message", late);
  expect(onNotify.mock.calls).toEqual([[early], [late]]);
  expect(child.kill).not.toHaveBeenCalled();
});

test("ignores malformed messages after ready with a log line", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const backend = start();
  child.emit("message", { type: "ready", port: 4321 });
  await backend.ready;
  for (const message of [
    { type: "notify", title: "", body: "empty title" },
    { type: "notify", title: "No body" },
    { type: "unknown" },
    "notify",
    null,
  ])
    child.emit("message", message);
  await vi.advanceTimersByTimeAsync(0);
  expect(error).toHaveBeenCalledTimes(5);
  expect(onNotify).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
  expect(onExit).not.toHaveBeenCalled();
  // The listener survives bad input.
  child.emit("message", {
    type: "notify",
    title: "Still listening",
    body: "",
    sound: "system",
  });
  expect(onNotify).toHaveBeenCalledOnce();
});
