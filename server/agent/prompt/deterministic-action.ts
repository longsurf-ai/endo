// Purpose: Groups selection and execution of one pre-model prompt-loop action.

import type {
  CompactionPart,
  SubtaskPart,
  WorkflowPart,
} from "@openchart/server/agent/contracts/part";
import { ascending } from "@openchart/identifier";
import { WorkflowTool } from "@openchart/server/agent/tool/tools/workflow";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { Effect } from "effect";
import { compact, needsCompaction } from "./compaction";
import { UnsupportedInput } from "./errors";
import type { TurnStep } from "./execute";
import { processStep } from "./step";

/** Selected work for this iteration; selection never performs the action. */
export type DeterministicAction =
  | WorkflowPart
  | SubtaskPart
  | CompactionPart
  | { readonly type: "auto-compaction" };

/**
 * Selects at most one action from committed history before a normal model step.
 * Part intents are pending only after the latest finished or terminal Assistant.
 * Their executors complete an ordinary Assistant step; no per-action consumption
 * marker is needed. Automatic compaction retains its state-based trigger.
 * Undefined leaves the model step to Prompt.
 * @example
 * const action = yield* nextDeterministicAction({messages, model});
 */
export const nextDeterministicAction = Effect.fn(
  "Prompt.nextDeterministicAction",
)(function* (input: Pick<TurnStep, "messages" | "model">) {
  const pending: DeterministicAction[] = [];
  for (const message of [...input.messages].reverse()) {
    if (
      message.info.role === "assistant" &&
      (message.info.finish || message.info.time.completed !== undefined)
    )
      break;
    for (const part of message.parts)
      if (
        part.type === "workflow" ||
        part.type === "subtask" ||
        (part.type === "compaction" && !part.auto)
      )
        pending.push(part);
  }
  // Completing one Assistant advances past the whole pending interval.
  // Multiple intents must never be silently skipped by that boundary.
  assertTrue(
    pending.length <= 1,
    "At most one deterministic action Part may be pending",
  );
  if (pending[0]) return pending[0];
  if (yield* needsCompaction(input.messages, input.model)) {
    return { type: "auto-compaction" } satisfies DeterministicAction;
  }
  return undefined;
});

/**
 * Executes the selected action through its owner, awaiting all durable writes.
 * Prompt rereads history after success instead of also running its normal model
 * step. Failures and interruption propagate through the enclosing run's Effect.
 * @example
 * yield* executeDeterministicAction(input, action);
 */
export const executeDeterministicAction = Effect.fn(
  "Prompt.executeDeterministicAction",
)(function* (input: TurnStep, action: DeterministicAction) {
  switch (action.type) {
    case "workflow":
      return yield* processStep(input, {
        toolName: WorkflowTool.id,
        callID: `call_${ascending()}`,
        args: { workflow: action.workflow, args: action.args },
      });
    case "subtask":
      return yield* new UnsupportedInput({
        type: action.type,
        detail: "This deterministic action is not implemented in V2.",
      });
    case "compaction": {
      const marker = input.messages.find(
        (message) => message.info.id === action.messageID,
      );
      assertExists(marker, "Compaction marker must belong to prompt history");
      assertTrue(
        marker.info.role === "user",
        "Compaction marker must be a User",
      );
      return yield* compact({ ...input, user: marker.info }, false);
    }
    case "auto-compaction":
      return yield* compact(input);
    default:
      return yield* Effect.die(action satisfies never);
  }
});
