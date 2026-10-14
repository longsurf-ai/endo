// Purpose: Exposes the host's system notification capability as a service that never fails.

/**
 * Host notification capability; stateless, with no Resource behind it.
 * @packageDocumentation
 */
export * as Notification from "./notification";

import { Context, Effect, Layer } from "effect";
import type { NotificationSound } from "@openchart/notification";
import { config } from "./config";

/** One system notification, optionally overriding the profile sound with a catalog ID. */
export interface Input {
  readonly title: string;
  readonly body: string;
  readonly sound?: NotificationSound;
}

/**
 * Host-supplied platform capability that displays one notification.
 * The service resolves an omitted sound from Config. The host owns presentation and may
 * throw; {@link layer} contains the failure.
 * @example
 * const notify: Notification.Notify = ({title, body}) => console.log(title, body);
 */
export type Notify = (
  notification: Input & { readonly sound: NotificationSound },
) => void;

/** Best-effort system notifications through the host platform. */
export interface Interface {
  /**
   * Asks the host to display one notification and never fails. A throwing host
   * is logged as an error; without a host capability the request is logged at
   * debug level. Nothing is stored, retried or acknowledged.
   * @example
   * const notification = yield* Notification.Service;
   * yield* notification.notify({title: "BTC breakout", body: "BTCUSDT has exceeded 70000"});
   */
  readonly notify: (input: Input) => Effect.Effect<void>;
}

/**
 * Notification capability supplied by application composition.
 * @example
 * const notification = yield* Notification.Service;
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Notification",
) {}

/**
 * Wraps the host capability; hosts without one (demo, tests) get a logging no-op.
 * @param notify - The host's `RuntimeOptions.notify`, when it supplies one.
 * @example
 * const services = Layer.merge(Notification.layer(options.notify), applicationServices);
 */
export const layer = (notify?: Notify) =>
  Layer.succeed(Service, {
    notify: Effect.fn("Notification.notify")(
      function* ({ title, body, sound: selectedSound }: Input) {
        if (!notify)
          return yield* Effect.logDebug(
            "Notification skipped: the host supplies no capability",
            { title, body },
          );
        const sound = selectedSound ?? (yield* config).sound;
        yield* Effect.try(() => notify({ title, body, sound }));
      },
      Effect.ignore({ log: "Error", message: "Notification delivery failed" }),
    ),
  });
