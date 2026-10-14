// Purpose: Owns process-local typed event publication and subscription.

import {
  Context,
  Effect,
  Layer,
  PubSub,
  Queue,
  Semaphore,
  Stream,
} from "effect";
import type { Scope } from "effect";

import type { Data, Definition, ID, Payload } from "./event-definition";
import { ID as EventID } from "./event-definition";
import { SubscriberOverflowError } from "./errors";

/** Optional envelope fields supplied by an event publisher. */
export interface PublishOptions {
  /** A caller-owned identifier used when the event already has an identity. */
  readonly id?: ID;
  /** Diagnostic or correlation values that do not change event semantics. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The process-local event capabilities consumed by application services. */
export interface Interface {
  /**
   * Same lock: these blocks cannot overlap. No missed or duplicated deltas.
   *
   * ```text
   * Observer: [ listen -> read snapshot    ]  -> send snapshot -> live events
   * Writer:   [ write -> commit -> publish ]
   *           [........ same lock .........]
   * ```
   *
   * Both sides must use it. No nesting or model/user waits inside the lock.
   * @example
   * const snapshot = yield* events.withBarrier(readSnapshot);
   */
  readonly withBarrier: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;

  /**
   * Starts listening now; the returned stream can be consumed later.
   *
   * ```text
   * publish -> PubSub -> [ e1 | e2 | ... ] -> consumer
   *                     bounded queue
   *                     full -> fail stream
   * ```
   *
   * Queues events while a snapshot is sent; the snapshot is not the queue.
   * Scope closes the listener, forwarding fiber, and queue.
   * @example
   * const stream = yield* events.allBounded(256);
   */
  readonly allBounded: (
    capacity: number,
  ) => Effect.Effect<
    Stream.Stream<Payload, SubscriberOverflowError>,
    never,
    Scope.Scope
  >;
  /**
   * Publishes one typed event to all current observers.
   *
   * Resource callers must invoke this only after their database transaction
   * commits. Publication is live-only and stores no history.
   *
   * @param definition - The feature-owned event declaration.
   * @param data - Data accepted by that declaration.
   * @param options - Optional event identity and metadata.
   * @returns The exact envelope delivered to subscribers.
   *
   * @example
   * ```ts
   * const events = yield* Events.Service;
   * yield* events.publish(Renamed, {id: 'one', name: 'Core'});
   * ```
   */
  readonly publish: <D extends Definition>(
    definition: D,
    data: Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Payload<D>>;
}

/**
 * The application event capability supplied by {@link layer}.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* Events.Service;
 *   return yield* events.allBounded(256);
 * });
 * ```
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Events",
) {}

/**
 * Acquires the shared service's observer; see {@link Interface.allBounded}.
 *
 * @param capacity - Maximum number of waiting payloads before explicit failure.
 * @returns An Effect that creates the bounded stream in the current scope.
 * @throws {@link SubscriberOverflowError} through the returned stream if its
 * consumer cannot keep up.
 *
 * @example
 * ```ts
 * const stream = yield* Events.allBounded(256);
 * ```
 */
export function allBounded(capacity: number) {
  return Service.use((events) => events.allBounded(capacity));
}

function bounded(all: PubSub.PubSub<Payload>, capacity: number) {
  return Effect.gen(function* () {
    // Subscribe synchronously in this scope before any snapshot read can begin.
    const subscription = yield* PubSub.subscribe(all);
    const queue = yield* Queue.dropping<Payload, SubscriberOverflowError>(
      capacity,
    );
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) =>
        Queue.offer(queue, event).pipe(
          Effect.flatMap((accepted) =>
            accepted
              ? Effect.void
              : Queue.fail(
                  queue,
                  new SubscriberOverflowError({ capacity }),
                ).pipe(Effect.andThen(Effect.interrupt)),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    return Stream.fromQueue(queue);
  });
}

/**
 * Builds one isolated pub/sub instance behind {@link Interface}.
 *
 * Every run owns a separate PubSub and barrier, shut down when the caller's
 * scope closes. {@link layer} holds the client-facing instance; the backend
 * Bus builds its own, so the mechanism exists once and instances never share
 * subscribers.
 *
 * @example
 * ```ts
 * const layer = Layer.effect(Service, Events.make);
 * ```
 */
export const make: Effect.Effect<Interface, never, Scope.Scope> = Effect.gen(
  function* () {
    const all = yield* PubSub.unbounded<Payload>();
    const barrier = yield* Semaphore.make(1);
    yield* Effect.addFinalizer(() => PubSub.shutdown(all));

    const publish = <D extends Definition>(
      definition: D,
      data: Data<D>,
      options?: PublishOptions,
    ) =>
      Effect.gen(function* () {
        const event = {
          id: options?.id ?? EventID.create(),
          type: definition.type,
          data,
          ...(options?.metadata ? { metadata: options.metadata } : {}),
        } as Payload<D>;
        yield* PubSub.publish(all, event as Payload);
        return event;
      });

    return {
      withBarrier: barrier.withPermit,
      allBounded: (capacity: number) => bounded(all, capacity),
      publish,
    };
  },
);

/**
 * Process-local live Events Layer.
 *
 * The Layer owns one PubSub and shuts it down with the application scope.
 * It has no Database dependency because events are notifications, not durable
 * state.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* Events.Service;
 *   return yield* events.publish(Renamed, {id: 'one', name: 'Core'});
 * }).pipe(Effect.provide(Events.layer));
 * ```
 */
export const layer = Layer.effect(Service, make);
