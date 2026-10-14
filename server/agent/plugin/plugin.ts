// Purpose: Creates and supplies one prompt's Plugin service for ordered lifecycle dispatch.

export * as Plugin from "./plugin";
export { bind } from "./bind";
export type {
  Catalog,
  Definition,
  Handlers,
  Hook,
  Invocation,
} from "./contract";

import { assertTrue } from "@openchart/utils/assert";
import { Context, Effect } from "effect";
import type { Catalog, Definition, Hook, Invocation } from "./contract";
import { HookFailed } from "./errors";
import { validateDefinitions } from "./registry";

/** Lifecycle dispatch for one prompt, derived from the invocation factory. */
export type Interface = Effect.Success<ReturnType<typeof create>>;

/**
 * The current prompt's plugin instances. Prompt creates and provides a fresh
 * service for each invocation, including children, under its own Scope.
 * @example
 * const plugins = yield* Plugin.Service;
 * const contexts = yield* plugins.trigger('run.before');
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Plugin",
) {}

/**
 * Creates fresh plugin instances after the trigger User commits. The caller
 * provides this service to the whole prompt execution and owns its Scope.
 * Common invocation facts are detached and frozen before setup; hook inputs
 * contain only facts specific to that lifecycle point. Closing the caller Scope
 * releases plugin-acquired resources on success, failure, or interruption.
 * @example
 * const plugins = yield* Plugin.create(definitions, invocation);
 * yield* execution.pipe(Effect.provideService(Plugin.Service, plugins));
 */
export const create = Effect.fn("AgentPlugin.create")(function* (
  definitions: readonly Definition[],
  invocation: Invocation,
) {
  validateDefinitions(definitions);
  const context = structuredClone(invocation);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(context);
  const bindings = yield* Effect.forEach(definitions, (definition) =>
    Effect.suspend(() => definition.create(context)).pipe(
      Effect.mapError(
        (cause) =>
          new HookFailed({
            pluginID: definition.id,
            hook: "create",
            runID: context.runID,
            triggerMessageID: context.triggerMessageID,
            cause,
          }),
      ),
      Effect.map((handlers) => {
        assertTrue(
          !definition.inputs?.length || handlers["run.before"] !== undefined,
          `Plugin ${definition.id} declares inputs without run.before`,
        );
        return { definition, handlers };
      }),
    ),
  );

  const dispatch = <Name extends Hook>(
    name: Name,
    ...args: Catalog[Name]["input"] extends void
      ? [input?: Catalog[Name]["input"]]
      : [input: Catalog[Name]["input"]]
  ) =>
    Effect.gen(function* () {
      const outputs: Catalog[Name]["output"][number][] = [];
      for (const { definition, handlers } of bindings) {
        const handler = handlers[name];
        if (!handler) continue;
        const value = yield* Effect.suspend(() =>
          handler(structuredClone(args[0])),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new HookFailed({
                pluginID: definition.id,
                hook: name,
                runID: context.runID,
                triggerMessageID: context.triggerMessageID,
                cause,
              }),
          ),
          Effect.withSpan("AgentPlugin.hook", {
            attributes: {
              "plugin.id": definition.id,
              hook: name,
              "run.id": context.runID,
            },
          }),
        );
        if (value !== undefined) outputs.push(...structuredClone(value));
      }
      return outputs;
    });

  return {
    /**
     * Collects hook outputs in binding order with detached inputs and results.
     * Hooks share the invocation's cancellation and resource scope.
     * @example
     * const plugins = yield* Plugin.Service;
     * yield* plugins.trigger('run.before');
     */
    trigger: dispatch,
  };
});
