// Purpose: Pin the parentPort message shapes both processes parse at their boundary.

import { expect, test } from "vitest";
import { BackendMessage, HostMessage, Ready } from "./host-protocol";

test("parses init and shutdown, rejecting unknown or incomplete messages", () => {
  const init = {
    type: "init",
    token: "t",
    home: "/p",
    rendererOrigin: "reagent://app",
  };
  expect(HostMessage.parse(init)).toEqual(init);
  expect(HostMessage.parse({ type: "shutdown" })).toEqual({ type: "shutdown" });
  expect(HostMessage.safeParse({ ...init, token: "" }).success).toBe(false);
  expect(HostMessage.safeParse({ ...init, home: "" }).success).toBe(false);
  expect(HostMessage.safeParse({ type: "ready", port: 1 }).success).toBe(false);
  expect(HostMessage.safeParse("shutdown").success).toBe(false);
});

test("parses ready with a TCP port only", () => {
  expect(Ready.parse({ type: "ready", port: 65535 })).toEqual({
    type: "ready",
    port: 65535,
  });
  expect(Ready.safeParse({ type: "ready", port: 0 }).success).toBe(false);
  expect(Ready.safeParse({ type: "ready", port: 1.5 }).success).toBe(false);
  expect(Ready.safeParse(4321).success).toBe(false);
});

test("parses everything the backend posts: ready and notify only", () => {
  const notify = {
    type: "notify",
    title: "BTC breakout",
    body: "",
    sound: "chime",
  };
  expect(BackendMessage.parse(notify)).toEqual(notify);
  expect(
    BackendMessage.safeParse({ ...notify, sound: "../custom.wav" }).success,
  ).toBe(false);
  expect(
    BackendMessage.safeParse({ ...notify, sound: undefined }).success,
  ).toBe(false);
  expect(BackendMessage.parse({ type: "ready", port: 1 })).toEqual({
    type: "ready",
    port: 1,
  });
  expect(BackendMessage.safeParse({ ...notify, title: "" }).success).toBe(
    false,
  );
  expect(BackendMessage.safeParse({ type: "notify", title: "t" }).success).toBe(
    false,
  );
  expect(BackendMessage.safeParse({ ...notify, body: 1 }).success).toBe(false);
  expect(BackendMessage.safeParse({ type: "shutdown" }).success).toBe(false);
  expect(BackendMessage.safeParse("notify").success).toBe(false);
});
