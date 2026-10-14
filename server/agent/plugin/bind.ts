// Purpose: Captures application dependencies without capturing a plugin invocation's lifetime.

import { Context, Effect, Scope } from "effect";
import type { Catalog, Definition, Handlers, Hook } from "./contract";

/**
 * Binds a definition to composition-owned services before catalog construction.
 * Mutable state and finalizers still belong to each later invocation. The captured
 * services must outlive every invocation using this binding.
 * @example
 * const plugin = yield* bind({id: 'context', agents: ['researcher'], create: () => Effect.succeed({
 *   'run.before': () => ContextSource.use(source => source.prepare()),
 * })});
 * const catalog = PluginRegistry.layer([plugin]);
 */
export const bind = Effect.fn("AgentPlugin.bind")(function* <R>(
  definition: Definition<R>,
) {
  const captured = yield* Effect.context<R>();
  return {
    ...definition,
    create: (invocation) =>
      Effect.gen(function* () {
        // Capturing application services must never retain the registration Scope.
        const scope = yield* Scope.Scope;
        const services = Context.add(captured, Scope.Scope, scope);
        const handlers = yield* definition
          .create(invocation)
          .pipe(Effect.provideContext(services));
        const close = <Name extends Hook>(name: Name) => {
          const handler = handlers[name];
          return handler
            ? (input: Catalog[Name]["input"]) =>
                handler(input).pipe(Effect.provideContext(services))
            : undefined;
        };
        return {
          "run.before": close("run.before"),
        } satisfies Handlers;
      }),
  } satisfies Definition;
});
