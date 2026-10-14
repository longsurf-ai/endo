// Purpose: Supplies the ordered plugin catalog and selects definitions independently of profiles.

export * as PluginRegistry from "./registry";

import {
  AgentPluginId,
  type PluginInput,
} from "@openchart/server/agent/contracts/part";
import { assertTrue } from "@openchart/utils/assert";
import { Context, Effect, Layer, Schema } from "effect";
import type { Definition } from "./contract";
import { UnhandledInput } from "./errors";

/**
 * Validates a selected set before input materialization or plugin setup.
 * @example
 * validateDefinitions(definitions);
 */
export function validateDefinitions(definitions: readonly Definition[]): void {
  const ids = new Set<string>();
  const inputs = new Set<PluginInput["type"]>();
  for (const definition of definitions) {
    Schema.decodeUnknownSync(AgentPluginId)(definition.id);
    assertTrue(!ids.has(definition.id), `Duplicate plugin ${definition.id}`);
    ids.add(definition.id);
    for (const input of definition.inputs ?? []) {
      assertTrue(!inputs.has(input), `Multiple plugins own input ${input}`);
      inputs.add(input);
    }
  }
}

/**
 * Rejects unhandled trigger inputs before materializing the User message.
 * @example
 * yield* PluginRegistry.requireInputs(definitions, pluginInputs, profile.name);
 */
export const requireInputs = Effect.fn("PluginRegistry.requireInputs")(
  function* (
    definitions: readonly Definition[],
    inputs: readonly PluginInput[],
    agent: string,
  ) {
    for (const input of inputs) {
      if (!definitions.some((plugin) => plugin.inputs?.includes(input.type)))
        return yield* new UnhandledInput({ agent, input: input.type });
    }
  },
);

/** Plugin discovery never constructs invocation handlers. */
export interface Interface {
  /**
   * Lists all definitions in catalog order, including plugins for other agents.
   * @example
   * const definitions = yield* registry.all();
   */
  readonly all: () => Effect.Effect<readonly Definition[]>;
}

/**
 * Application-owned plugin catalog, independent of profile configuration.
 * @example
 * const registry = yield* PluginRegistry.Service;
 * const definitions = resolve(yield* registry.all(), 'analyst');
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/PluginRegistry",
) {}

/**
 * Supplies definitions without running setup. Captured application services must
 * outlive all invocations using this catalog. Definitions and selectors are copied
 * and frozen so callers cannot change an invocation's selection after discovery.
 * @example
 * const catalog = PluginRegistry.layer([contextPlugin]);
 */
export function layer(definitions: readonly Definition[]) {
  return Layer.sync(Service, () => {
    const all = Object.freeze(
      definitions.map((definition) =>
        Object.freeze({
          ...definition,
          agents: Object.freeze([...definition.agents]),
          inputs: definition.inputs
            ? Object.freeze([...definition.inputs])
            : undefined,
        }),
      ),
    );
    return { all: () => Effect.succeed(all) };
  });
}

/**
 * Selects and validates one agent's definitions in catalog order without setup.
 * Duplicate identities or input owners in the selected set are defects. Different
 * agents may use different plugins to prepare the same input type.
 * @example
 * const definitions = resolve(yield* registry.all(), profile.name);
 */
export function resolve(all: readonly Definition[], agent: string) {
  const definitions = all.filter((definition) =>
    definition.agents.includes(agent),
  );
  validateDefinitions(definitions);
  return definitions;
}

/**
 * Supplies an empty catalog when no feature plugins are installed.
 * @example
 * const all = yield* Service.use(registry => registry.all()).pipe(
 *   Effect.provide(PluginRegistry.layerDefault),
 * );
 */
export const layerDefault = layer([]);
