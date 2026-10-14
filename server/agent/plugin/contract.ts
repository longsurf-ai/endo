// Purpose: Defines trusted invocation plugins and their typed lifecycle inputs and outputs.

import type {
  PluginContext,
  PluginInput,
} from "@openchart/server/agent/contracts/part";
import type { Effect, Scope } from "effect";

/** Fixed prompt context shared by all hooks; identity is supplied by Prompt. */
export interface Invocation {
  readonly runID: string;
  readonly sessionID: string;
  readonly triggerMessageID: string;
  readonly agent: string;
  readonly pluginInputs: readonly PluginInput[];
  /** The invocation's selected model; individual requests may use another model. */
  readonly model: { readonly providerID: string; readonly modelID: string };
}

/** The sole hook catalog. Plugins return data, never mutate requests. */
export interface Catalog {
  readonly "run.before": {
    readonly input: void;
    readonly output: readonly PluginContext[];
  };
}

/** Lifecycle names derive from the central catalog. */
export type Hook = keyof Catalog;

/** Handlers belong to one invocation and use its Effect cancellation scope. */
export type Handlers<R = never> = {
  readonly [Name in Hook]?: (
    input: Catalog[Name]["input"],
  ) => Effect.Effect<Catalog[Name]["output"] | void, unknown, R>;
};

/**
 * Executable plugin definition. Capture application dependencies when constructing
 * the definition; allocate mutable run state only inside create. Definitions are
 * trusted internal code and never part of public or persisted profile data.
 */
export interface Definition<R = never> {
  readonly id: string;
  /** Exact profile names selected by this plugin; selection preserves catalog order. */
  readonly agents: readonly string[];
  /** Each input type has exactly one preparation owner in a profile. */
  readonly inputs?: readonly PluginInput["type"][];
  /**
   * Creates fresh handlers and registers cleanup in the invocation's Scope.
   * Expected failures fail the invocation; defects and interruption propagate.
   * @example
   * create: invocation => Effect.succeed({'run.before': () => Effect.succeed([
   *   {kind: 'plugin', pluginId, hook: 'run.before', content: invocation.sessionID},
   * ])})
   */
  readonly create: (
    invocation: Invocation,
  ) => Effect.Effect<Handlers<R>, unknown, R | Scope.Scope>;
}
