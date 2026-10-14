import { type Assistant } from "@openchart/server/agent/contracts/message";
import { type StepFinishPart } from "@openchart/server/agent/contracts/part";
import { commit } from "@openchart/server/agent/session/commit";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { assertTrue } from "@openchart/utils/assert";
import { Effect } from "effect";

/** Assistant state and its corresponding step marker, committed together. */
export interface FinishStepInput {
  readonly message: Assistant;
  readonly part: StepFinishPart;
}

/**
 * Commits an Assistant header and its StepFinishPart as one durable operation.
 *
 * The marker must belong to that Assistant. Delivers both committed facts in
 * one change only after both writes commit; either failure rolls back both.
 * Call outside an existing transaction. The processor supplies completion and
 * usage facts; this operation does not choose model-loop transitions.
 *
 * @example
 * ```ts
 * const saved = yield* finishStep({message: assistant, part: stepFinish});
 * ```
 */
export const finishStep = Effect.fn("Message.finishStep")(function* (
  input: FinishStepInput,
) {
  assertTrue(
    input.part.messageID === input.message.id,
    "StepFinishPart must belong to the completed Assistant",
  );
  const publisher = yield* Publisher.Service;
  return yield* commit(
    (tx) =>
      Effect.gen(function* () {
        const message = yield* messageStore.update(tx, input.message);
        const part = yield* messageStore.insertPart(tx, input.part);
        return { message, part };
      }),
    (saved) => publisher.publish({ type: "step.finished", ...saved }),
  );
});
