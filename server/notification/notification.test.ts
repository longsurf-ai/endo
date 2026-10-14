// Purpose: Verifies host notification delivery stays exact and can never fail its caller.

import { temporaryHome } from "@openchart/server/home.test-utils";
import { makeRuntime } from "@openchart/server/runtime";
import { ConfigFile } from "@openchart/server/config";
import { ConfigInvalid } from "@openchart/server/config/errors";
import { ConfigProvider, Effect, Schema } from "effect";
import { expect, test, vi } from "vitest";

import { Notification } from "./notification";
import { NotificationSettings } from "./config";

const notify = Notification.Service.use((service) =>
  service.notify({ title: "BTC breakout", body: "BTCUSDT has exceeded 70000" }),
);

test("hands the host title, body and configured sound without leaking caller fields", async () => {
  const host = vi.fn();
  // A wider caller object must not leak fields into the host message.
  const input = {
    title: "BTC breakout",
    body: "exceeded",
    type: "init",
  };
  await Effect.runPromise(
    Notification.Service.use((service) => service.notify(input)).pipe(
      Effect.provide(Notification.layer(host)),
    ),
  );
  expect(host).toHaveBeenCalledExactlyOnceWith({
    title: "BTC breakout",
    body: "exceeded",
    sound: "chime",
  });
});

test.each(["glass", "none", "system"] as const)(
  "a notification can override the profile sound with %s",
  async (sound) => {
    const host = vi.fn();
    await Effect.runPromise(
      Notification.Service.use((service) =>
        service.notify({ title: "AAPL alert", body: "Moved", sound }),
      ).pipe(Effect.provide(Notification.layer(host))),
    );
    expect(host).toHaveBeenCalledExactlyOnceWith({
      title: "AAPL alert",
      body: "Moved",
      sound,
    });
  },
);

test("a throwing host never fails the caller", async () => {
  const host = vi.fn(() => {
    throw new Error("parent port closed");
  });
  await expect(
    Effect.runPromise(notify.pipe(Effect.provide(Notification.layer(host)))),
  ).resolves.toBeUndefined();
  expect(host).toHaveBeenCalledOnce();
});

test("without a host capability notify is a no-op", async () => {
  await expect(
    Effect.runPromise(notify.pipe(Effect.provide(Notification.layer()))),
  ).resolves.toBeUndefined();
});

test("the application runtime provides the host's notify option", async () => {
  const host = vi.fn();
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    config: ConfigProvider.fromUnknown({}),
    notify: host,
  });
  try {
    await runtime.runPromise(notify);
    expect(host).toHaveBeenCalledExactlyOnceWith({
      title: "BTC breakout",
      body: "BTCUSDT has exceeded 70000",
      sound: "chime",
    });
  } finally {
    await runtime.dispose();
  }
});

test("sound changes apply to the next notification without restarting the runtime", async () => {
  const host = vi.fn();
  const runtime = makeRuntime({
    home: temporaryHome(),
    databasePath: ":memory:",
    notify: host,
  });
  try {
    await runtime.runPromise(notify);
    for (const sound of ["glass", "none", "system"] as const) {
      await runtime.runPromise(
        ConfigFile.use((file) =>
          file.update({ notifications: { sound } }, (merged) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({ notifications: NotificationSettings }),
            )(merged).pipe(
              Effect.mapError((cause) => new ConfigInvalid({ cause })),
            ),
          ),
        ),
      );
      await runtime.runPromise(notify);
      expect(host).toHaveBeenLastCalledWith({
        title: "BTC breakout",
        body: "BTCUSDT has exceeded 70000",
        sound,
      });
    }
    expect(host).toHaveBeenCalledTimes(4);
  } finally {
    await runtime.dispose();
  }
});

test("invalid sound configuration is logged, never silently replaced or allowed to fail the caller", async () => {
  const host = vi.fn();
  await expect(
    Effect.runPromise(
      notify.pipe(
        Effect.provide(Notification.layer(host)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            notifications: { sound: "../../arbitrary.wav" },
          }),
        ),
      ),
    ),
  ).resolves.toBeUndefined();
  expect(host).not.toHaveBeenCalled();
});
