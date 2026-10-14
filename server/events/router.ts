// Purpose: Adapts the generic application event stream to a tRPC SSE subscription.

import { trpc } from "@openchart/server/lib/trpc";
import { Effect, Stream } from "effect";

import * as Events from "./events";
import type { Payload } from "./event-definition";

const SUBSCRIBER_CAPACITY = 256;

/** Registration readiness or a live application event on the shared connection. */
export type Frame = { kind: "ready" } | { kind: "event"; event: Payload };

const subscribe = Stream.unwrap(
  Events.allBounded(SUBSCRIBER_CAPACITY).pipe(
    Effect.map((live) =>
      // Readiness is sent only after registration. Consumers can now request
      // snapshots without missing their publication on this connection.
      Stream.concat(
        Stream.fromIterable<Frame>([{ kind: "ready" }]),
        live.pipe(Stream.map((event): Frame => ({ kind: "event", event }))),
      ),
    ),
  ),
);

/**
 * Event-agnostic tRPC router whose `subscribe` procedure streams SSE.
 *
 * The procedure sends readiness, then generic {@link Payload} envelopes. It imports
 * no concrete event definition, creates one bounded queue per connection, and
 * closes that queue when tRPC aborts the subscription. tRPC owns SSE framing,
 * serialization, heartbeat, and client reconnection.
 *
 * @example
 * ```ts
 * const subscription = client.events.subscribe.subscribe(undefined, {
 *   onData: frame => {
 *     if (frame.kind === 'event') console.log(frame.event.type);
 *   },
 * });
 * ```
 */
export const eventsRouter = trpc.router({
  subscribe: trpc.procedure.subscription(({ ctx }) =>
    ctx.runtime.runPromise(Stream.toAsyncIterableEffect(subscribe)),
  ),
});
