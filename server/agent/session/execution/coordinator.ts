// Purpose: Serializes one execution per session while allowing sessions to run concurrently.

export * as SessionRunCoordinator from "./coordinator";

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect";

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>;
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>;
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>;
}

/** Tracks one active execution for a key. */
type Entry = {
  /** Current drain fiber, replaced when the same execution drains again. */
  owner?: Fiber.Fiber<void, never>;
  /** Whether one or more wakes must be handled after the current drain. */
  pendingWake: boolean;
  /** Whether the current drain is being interrupted before cleanup completes. */
  stopping: boolean;
};

/**
 * Creates a scope-owned keyed execution coordinator.
 *
 * @param options - The drain operation serialized for each key.
 * @returns A coordinator whose fibers share its construction context and are
 * interrupted when its scope closes.
 *
 * @example
 * ```ts
 * const coordinator = yield* SessionRunCoordinator.make({
 *   drain: sessionID => runner.run({sessionID}),
 * });
 * ```
 */
export const make = <Key, E, R>(options: {
  readonly drain: (key: Key) => Effect.Effect<void, E, R>;
}): Effect.Effect<Coordinator<Key>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry>();

    // Drain fibers belong to this coordinator's Scope, not to wake callers.
    // This way, when the HTTP request finishes, the drain fiber can continue
    // until completion.
    // Capture drain requirements here so wakes never depend on request context.
    const fork = yield* FiberSet.makeRuntime<R, void, never>();

    const makeEntry = (): Entry => ({
      pendingWake: false,
      stopping: false,
    });

    const start = (key: Key, entry: Entry, successor = false) => {
      const ready = Deferred.makeUnsafe<void>();
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      );
      entry.owner = owner;
      if (!successor) Deferred.doneUnsafe(ready, Effect.void);
    };

    const settle = (key: Key, entry: Entry, exit: Exit.Exit<void, E>) => {
      // During a successful drain, if a wake was registered, we immediately start
      // a successor drain. This way, the next drain is guaranteed to see the new
      // work, and we avoid a race where a wake is registered after the drain
      // finishes.
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false;
        start(key, entry, true);
        return;
      }

      const successor = entry.pendingWake ? makeEntry() : undefined;
      if (successor === undefined) active.delete(key);
      else {
        active.set(key, successor);
        start(key, successor, true);
      }
    };

    const wake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key);
        if (entry !== undefined) {
          entry.pendingWake = true;
          return;
        }

        const next = makeEntry();
        active.set(key, next);
        start(key, next);
      });

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key);
        if (entry?.owner === undefined) return Effect.void;
        entry.stopping = true;
        entry.pendingWake = false;
        return Fiber.interrupt(entry.owner);
      });

    return {
      active: Effect.sync(() => new Set(active.keys())),
      wake,
      interrupt,
    };
  });
