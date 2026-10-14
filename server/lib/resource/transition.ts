// Purpose: Defines typed transition declarations and binds inputs to lazy resolve/apply programs.

import { Effect, Schema } from "effect";

import type { Tx } from "./store";

/**
 * An input-bound operation whose resolved facts feed one transaction phase.
 *
 * Constructing a transition performs no work. Resolve external facts before
 * opening the transaction; read consistent Resource state through `tx` in
 * apply. Compose transitions by composing both phases, then run the result
 * once. Apply requires no additional Effect services; this is not a sandbox
 * against direct external IO or capabilities captured in closures.
 */
export interface Transition<
  Resolved,
  A,
  EResolve = never,
  EApply = never,
  RResolve = never,
> {
  /** External facts to obtain before opening the transaction. */
  readonly resolve: Effect.Effect<Resolved, EResolve, RResolve>;
  /**
   * Executes the operation using the supplied transaction and resolved facts.
   * Never opens or commits a transaction of its own.
   *
   * @example
   * ```ts
   * const resolved = yield* child.resolve;
   * // Inside the composed transition's apply:
   * const result = yield* child.apply(tx, resolved);
   * ```
   */
  readonly apply: (tx: Tx, resolved: Resolved) => Effect.Effect<A, EApply>;
}

/** Public operation semantics; omitted kinds retain mutation behavior. */
export type Kind = "query" | "mutation";

/** A reusable operation declaration; its input schema owns the wire boundary. */
export interface Definition<
  Input extends Schema.Top,
  Resolved,
  A,
  EResolve,
  EApply,
  RResolve,
  K extends Kind = Kind,
> {
  /** Query declarations must only read; this metadata does not enforce purity. */
  readonly kind?: K;
  readonly input: Input & { readonly DecodingServices: never };
  readonly resolve: (
    input: Input["Type"],
  ) => Effect.Effect<Resolved, EResolve, RResolve>;
  readonly apply: (
    tx: Tx,
    input: Input["Type"],
    resolved: Resolved,
  ) => Effect.Effect<A, EApply>;
}

/** Heterogeneous declarations retain their resolver services at composition boundaries. */
export interface AnyDefinition<R = unknown> {
  readonly kind?: Kind;
  readonly input: Schema.Top & { readonly DecodingServices: never };
  readonly resolve: (input: never) => Effect.Effect<unknown, unknown, R>;
  readonly apply: (
    tx: Tx,
    input: never,
    resolved: never,
  ) => Effect.Effect<unknown, unknown>;
}

/** Operation names are declared once, as keys in the Resource's transition map. */
export type Definitions<R = unknown> = Readonly<
  Record<string, AnyDefinition<R>>
>;

/** A declaration bound to decoded input, preserving results, errors, and services. */
export type Bound<
  D extends AnyDefinition,
  R = Effect.Services<ReturnType<D["resolve"]>>,
> = (
  input: D["input"]["Type"],
) => Transition<
  Effect.Success<ReturnType<D["resolve"]>>,
  Effect.Success<ReturnType<D["apply"]>>,
  Effect.Error<ReturnType<D["resolve"]>>,
  Effect.Error<ReturnType<D["apply"]>>,
  R
>;

/** Resource methods derived from its named declarations. */
export type BoundDefinitions<D extends Definitions> = {
  readonly [K in keyof D]: Bound<D[K]>;
};

/**
 * Preserves input, resolver-result, and apply-result types without executing work.
 * Supply an input schema and phase functions for a reusable Resource declaration;
 * supply an Effect resolver and apply for an already-bound composition.
 * The declaration's name belongs to its registration key, not this constructor.
 * Declare `kind: "query"` for public reads; omitted kinds expose mutations.
 * Binding and execution retain the same resolve/apply contract for both kinds.
 *
 * @example
 * ```ts
 * const rename = Transition.make({
 *   input: Schema.Struct({name: Schema.String}),
 *   resolve: input => lookupName(input.name),
 *   apply: (tx, input, name) => updateName(tx, input.name, name),
 * });
 * ```
 */
export function make<
  Input extends Schema.Top,
  Resolved,
  A,
  EResolve,
  EApply,
  RResolve,
  const K extends Kind = "mutation",
>(
  transition: Definition<Input, Resolved, A, EResolve, EApply, RResolve, K>,
): Definition<Input, Resolved, A, EResolve, EApply, RResolve, K>;
export function make<Resolved, A, EResolve, EApply, RResolve>(
  transition: Transition<Resolved, A, EResolve, EApply, RResolve>,
): Transition<Resolved, A, EResolve, EApply, RResolve>;
export function make(transition: unknown): unknown {
  return transition;
}

/**
 * Binds one declaration to decoded input without running either phase.
 * Both Resource factories and transport adapters use this binding; resolver
 * construction stays deferred and resolver-service requirements are retained.
 *
 * @example
 * ```ts
 * const operation = Transition.bindInput(promote, input);
 * const result = yield* Transactor.run(operation);
 * ```
 */
export function bindInput<R, D extends AnyDefinition<R>>(
  definition: D & AnyDefinition<R>,
  input: D["input"]["Type"],
): ReturnType<Bound<D, R>> {
  const operation: AnyDefinition<R> = definition;
  // Restore the declaration's correlated input/results; services remain R on both sides.
  return {
    resolve: Effect.suspend(() => operation.resolve(input as never)),
    apply: (tx: Tx, resolved: unknown) =>
      operation.apply(tx, input as never, resolved as never),
  } as ReturnType<Bound<D, R>>;
}

/**
 * Binds named declarations without parsing input or executing either phase.
 * Resolver construction is deferred until execution, just like its IO.
 *
 * @example
 * ```ts
 * const transitions = Transition.bind({promote});
 * const operation = transitions.promote(input);
 * ```
 */
export function bind<D extends Definitions>(
  definitions: D,
): BoundDefinitions<D> {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, definition]) => [
      name,
      (input: never) => bindInput(definition, input),
    ]),
  ) as BoundDefinitions<D>;
}

/**
 * Wraps a transaction operation that needs no external resolution.
 * The empty resolver gives it the same shape as every other transition.
 * Neither the operation nor any identifier generation runs until apply.
 *
 * @param apply - Operation to execute in the caller's transaction.
 * @returns A transition with a void resolver and the operation's result and errors.
 *
 * @example
 * ```ts
 * const read = Transition.from(tx => store.load(tx, id));
 * const row = yield* Transactor.run(read);
 * ```
 */
export function from<A, E>(
  apply: (tx: Tx) => Effect.Effect<A, E>,
): Transition<void, A, never, E> {
  return { resolve: Effect.void, apply };
}
