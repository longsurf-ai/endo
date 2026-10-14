// Purpose: Enqueues agent prompts and wakes session execution for all callers.

import { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import { SessionExecution } from "@openchart/server/agent/session/execution";
import { Effect, Schema, Struct } from "effect";

/** Prompt content with its target session and stable submission intent. */
export const PromptRequest = Schema.Struct({
  sessionID: Schema.String.check(Schema.isMinLength(1)),
  sessionIntentID: Schema.String.check(Schema.isMinLength(1)),
  input: AgentPromptInput,
})
  .mapFields(Struct.map(Schema.mutableKey))
  .annotate({ parseOptions: { onExcessProperty: "error" } });

/** Parsed request shared by transport adapters and server callers. */
export type PromptRequest = typeof PromptRequest.Type;

/**
 * Shared Agent submission entry for frontend adapters and backend callers.
 * Scheduler and Trigger enter here through admitPromptTarget.
 *
 * ```text
 * Frontend / tRPC adapter          Backend / direct caller
 * runtime.runPromise(...)          yield* ...
 *             |                         |
 *             +------------+------------+
 *                          v
 *              submitPrompt(PromptRequest)
 *                          |
 *                          v
 *              AgentRunStore.enqueue(request)
 *              persist a run or replay its intent
 *                          |
 *                          v
 *              SessionExecution.wake(sessionID)
 *                          |                |
 *                          v                v
 *                return accepted run    Coordinator
 *                                           |
 *                                           v
 *                                       Runner
 *                                           |
 *                                           v
 *                                       Prompt
 * ```
 *
 * @agent invariant: This function owns the enqueue -> wake -> return sequence
 * for every submission source. Adapters must not duplicate that sequence or
 * invoke Prompt directly. Execution remains owned by the runner;
 * submitting a prompt does not wait for its execution to finish.
 *
 * Callers supply the same request shape: sessionID selects the conversation,
 * sessionIntentID identifies one submission, and input is AgentPromptInput.
 * The selected session must already be persisted before submission.
 * Retries of the same submission reuse the intent ID. Transport adapters parse
 * untrusted requests before entering this typed function; trigger-specific
 * decisions, such as when a schedule fires, remain with the caller.
 *
 * Wake follows successful enqueue; a failed enqueue never wakes execution.
 * Future integration with an outer transaction must keep wake after that
 * transaction commits; this function currently has no such integration.
 *
 * @param input - Parsed submission with a stable intent ID and prompt snapshot.
 * @returns The durable run accepted or replayed by the store, without waiting
 * for prompt execution to finish.
 *
 * @example
 * ```ts
 * const run = yield* submitPrompt({sessionID, sessionIntentID, input});
 * ```
 */
export const submitPrompt = Effect.fn("Agent.submitPrompt")(function* (
  input: PromptRequest,
) {
  const store = yield* AgentRunStore.Service;
  const execution = yield* SessionExecution.Service;
  const run = yield* store.enqueue(input);
  yield* execution.wake(input.sessionID);
  return run;
});
