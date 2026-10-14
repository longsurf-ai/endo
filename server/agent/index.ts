// Purpose: Connects durable agent-run scheduling to prompt execution.

/**
 * Provides durable agent-run admission and process-local execution scheduling.
 * Claimed runs execute the prompt engine through Prompt.Service.
 *
 * @packageDocumentation
 */

import { Prompt } from "@openchart/server/agent/prompt/prompt";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { SessionRunner } from "@openchart/server/agent/session/runner";
import { Layer } from "effect";
import { interruptAndRecover } from "./recovery";

export { agentRouter } from "./router";

const runner = SessionRunner.layer.pipe(
  Layer.provideMerge(Prompt.layer),
  Layer.provideMerge(AgentRunStore.layer),
);

const execution = SessionExecution.layer.pipe(Layer.provideMerge(runner));

/**
 * Repairs abandoned execution, then starts queued work using application-owned
 * services. Initialization fails before exposing Agent if repair cannot commit.
 *
 * @example
 * ```ts
 * const agent = agentLayer.pipe(Layer.provideMerge(applicationDependencies));
 * ```
 */
export const agentLayer = Layer.effectDiscard(interruptAndRecover()).pipe(
  Layer.provideMerge(execution),
);
