// Purpose: Exposes claimed prompt execution with a stable failure boundary for Runner.

export * as Prompt from "./prompt";

import type { AgentRun } from "@openchart/server/agent/run/run";
import { Context, Effect, Layer } from "effect";

import { Failed } from "./errors";
import { execute } from "./execute";

const executePrompt = (run: AgentRun) =>
  execute(run).pipe(Effect.mapError((cause) => new Failed({ cause })));

/** Prompt execution required by the durable Session runner. */
export interface Interface {
  /**
   * Executes one already-claimed intent; Runner retains its terminal transition.
   *
   * @param run - Durable running row whose input must be handled exactly once.
   * @returns Success after execution finishes, or Failed for an expected error.
   * Defects and interruption retain their Effect causes.
   *
   * @example
   * ```ts
   * const prompt = yield* Prompt.Service;
   * yield* prompt.execute(run);
   * ```
   */
  readonly execute: typeof executePrompt;
}

/**
 * Injectable prompt execution consumed by SessionRunner.
 * @example
 * const prompt = yield* Prompt.Service;
 * yield* prompt.execute(claimedRun);
 */
export class Service extends Context.Service<Service, Interface>()(
  "@openchart/server/Prompt",
) {}

/**
 * Provides the engine using the caller's service context. Only expected failures
 * become Failed; defects and interruption preserve their original causes.
 * @example
 * const runner = runnerLayer.pipe(Layer.provide(Prompt.layer));
 */
export const layer = Layer.succeed(Service, {
  execute: executePrompt,
});
