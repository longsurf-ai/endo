// Purpose: Replays scoped profile contributions and publishes complete registry states.

export * as State from "./state";

import { Context, Effect, Scope, Semaphore } from "effect";

type TransformCallback<Draft> = (draft: Draft) => Effect.Effect<void> | void;

/** A contribution can be removed explicitly or by closing its registering Scope. */
export interface Registration {
  /** Removes this contribution once and rebuilds the remaining registry. */
  readonly dispose: Effect.Effect<void>;
}

/** Registers a replayable contribution whose lifetime belongs to the caller's Scope. */
export type Transform<Draft> = (
  transform: TransformCallback<Draft>,
) => Effect.Effect<Registration, never, Scope.Scope>;

/** Replays all currently registered contributions. */
export type Reload = () => Effect.Effect<void>;

/** Scoped updates shared by the registry and its service interface. */
export interface Transformable<Draft> {
  /**
   * Registers an update and rebuilds the registry; invalid updates are defects.
   * @example
   * const registration = yield* profiles.transform(draft => draft.remove('title'));
   */
  readonly transform: Transform<Draft>;
  /**
   * Rebuilds from the initial value and all active updates, in registration order.
   * @example
   * yield* profiles.reload();
   */
  readonly reload: Reload;
}

const CurrentBatch = Context.Reference<Set<Reload> | undefined>(
  "@openchart/AgentProfile/State/CurrentBatch",
  { defaultValue: () => undefined },
);

/**
 * Defers contribution rebuilds until a group of registrations has completed.
 * Nested batches reuse the outer batch. Explicit reload calls still run immediately.
 * @example
 * yield* State.batch(Effect.gen(function* () {
 *   yield* profiles.transform(registerBuiltins);
 *   yield* profiles.transform(applyConfiguration);
 * }));
 */
export function batch<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const current = yield* CurrentBatch;
    if (current) return yield* effect;
    const reloads = new Set<Reload>();
    const result = yield* effect.pipe(
      Effect.provideService(CurrentBatch, reloads),
    );
    yield* Effect.forEach(reloads, (reload) => reload(), { discard: true });
    return result;
  });
}

/** Construction and validation hooks for a replayable registry. */
export interface Options<Value, Draft> {
  /**
   * Creates a fresh base on every rebuild.
   * @example
   * initial: () => ({agents: new Map()})
   */
  readonly initial: () => Value;
  /**
   * Exposes the domain's edits over a private candidate value.
   * @example
   * draft: value => ({remove: name => { value.agents.delete(name); }})
   */
  readonly draft: (value: Value) => Draft;
  /**
   * Validates the complete candidate before it replaces the published value.
   * @example
   * finalize: draft => Effect.sync(() => validate(draft.list()))
   */
  readonly finalize?: (draft: Draft) => Effect.Effect<void>;
}

/** A published registry value and its scoped contribution API. */
export interface Interface<Value, Draft> extends Transformable<Draft> {
  /**
   * Reads the last completely rebuilt value without waiting for in-flight updates.
   * @example
   * const current = state.get();
   */
  readonly get: () => Value;
}

/**
 * Creates an instance-local registry with serialized, atomic publication.
 * Failed rebuilds retain the previously published value. A failed direct
 * registration is removed before its defect is propagated.
 * @example
 * const state = State.create({
 *   initial: () => new Map<string, string>(),
 *   draft: value => ({set: (key: string, text: string) => { value.set(key, text); }}),
 * });
 */
export function create<Value, Draft>(
  options: Options<Value, Draft>,
): Interface<Value, Draft> {
  let state = options.initial();
  let transforms: { run: TransformCallback<Draft> }[] = [];
  const semaphore = Semaphore.makeUnsafe(1);

  const materialize = Effect.fnUntraced(function* () {
    const next = options.initial();
    const draft = options.draft(next);
    for (const transform of transforms) {
      yield* Effect.suspend(() => {
        const result = transform.run(draft);
        return Effect.isEffect(result) ? result : Effect.void;
      });
    }
    if (options.finalize) yield* options.finalize(draft);
    state = next;
  });

  const reload = () => semaphore.withPermit(materialize());

  return {
    get: () => state,
    transform: Effect.fn("AgentProfile.State.transform")(function* (update) {
      const scope = yield* Scope.Scope;
      const transform = { run: update };
      let active = true;
      const dispose = Effect.gen(function* () {
        if (!active) return;
        active = false;
        transforms = transforms.filter((item) => item !== transform);
        const batch = yield* CurrentBatch;
        if (batch) batch.add(reload);
        else yield* materialize();
      }).pipe(semaphore.withPermit, Effect.uninterruptible);

      return yield* Effect.gen(function* () {
        yield* semaphore.withPermit(
          Effect.sync(() => {
            transforms = [...transforms, transform];
          }),
        );
        yield* Scope.addFinalizer(scope, dispose);
        const batch = yield* CurrentBatch;
        if (batch) batch.add(reload);
        else yield* reload().pipe(Effect.onError(() => dispose));
        return { dispose };
      }).pipe(Effect.uninterruptible);
    }),
    reload,
  };
}
