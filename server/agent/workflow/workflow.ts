// Purpose: Supplies workflow invocation data, execution settings, and child-agent capabilities.

export * as Workflow from "./workflow";

import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { Context, type Effect, type Schema } from "effect";

/** Host-owned execution limits, shared by the workflow's top-level verbs. */
export interface Settings {
  readonly concurrency: number;
}

/** A child's durable identity and final output, explicitly passed to later agents. */
export type AgentResult<A = string> = {
  readonly sessionId: string;
  readonly output: A;
};

/**
 * The sole workflow service, scoped to one prompt invocation and never retained
 * by the application tool catalog.
 * @example
 * const workflow = yield* Workflow.Service;
 * const child = yield* workflow.agent(prompt, () => Effect.void);
 */
export class Service extends Context.Service<
  Service,
  {
    readonly parentPrompt: AgentPromptInput;
    /**
     * Reads current Resource state through the host's database without a separate
     * permission check. Invalid names/IDs, missing entities, and storage failures
     * fail the Effect; the read transaction closes before it settles.
     * @example const row = yield* host.getResource("agent_schedule", id);
     */
    readonly getResource: (
      name: string,
      id: string,
    ) => Effect.Effect<unknown, unknown>;
    readonly settings: Settings;
    /**
     * Creates or continues an owned child Session under the existing root Run.
     * Calls sharing a Session execute serially, including transcript cleanup/read.
     * The workflow runtime wraps this with the invocation's concurrency limit.
     * @example
     * const result = yield* host.agent(prompt, () => Effect.void);
     */
    readonly agent: (
      input: AgentPromptInput,
      onSession: (sessionId: string) => Effect.Effect<void, unknown>,
      options?: {
        readonly sessionId?: string;
        readonly title?: string;
        readonly outputSchema?: Schema.JsonObject;
      },
    ) => Effect.Effect<AgentResult, unknown>;
  }
>()("@openchart/server/Workflow") {}
