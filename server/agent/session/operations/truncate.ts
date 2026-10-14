// Purpose: Truncates idle Session history without admitting or starting Agent work.
import { SessionId } from "@openchart/server/agent/contracts/session";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { commit } from "@openchart/server/agent/session/commit";
import {
  SessionBusy,
  TruncateUnavailable,
} from "@openchart/server/agent/session/errors";
import { readHistoryThrough } from "@openchart/server/agent/session/operations/internal/read-history-through";
import { messageStore } from "@openchart/server/agent/session/message/store";
import { sessionStore } from "@openchart/server/agent/session/store";
import { Effect, Schema } from "effect";

/** Inclusive Assistant boundary; explicit null clears the complete transcript. */
export const TruncateInput = Schema.Struct({
  sessionID: SessionId,
  messageID: Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Parsed history preparation request, without prompt content or execution intent. */
export type TruncateInput = typeof TruncateInput.Type;

/**
 * Retains chat history through a completed Assistant, or clears it for null.
 * Checks idle execution, deletes trailing Messages/Parts and removes their anchors
 * in one transaction, then publishes the committed Session and transcript.
 * Retained identities, child Sessions and historical Runs stay unchanged. Queued
 * or running work, non-chat Sessions, missing targets and unfinished/non-Assistant
 * boundaries fail without writes or publication.
 * No Run is admitted or woken; callers separately submitPrompt with edited input.
 * Call outside an existing transaction. Two preparation/submission calls are not atomic.
 * @example yield* sessions.truncate({ sessionID, messageID: lastAssistantID });
 * @example yield* sessions.truncate({ sessionID, messageID: null });
 */
export const truncate = Effect.fn("Session.truncate")(function* (
  input: TruncateInput,
) {
  const publisher = yield* Publisher.Service;
  yield* commit(
    (tx) =>
      Effect.gen(function* () {
        const { source, history } = yield* readHistoryThrough(
          tx,
          input.sessionID,
          input.messageID,
        );
        if (source.kind !== "chat") return yield* new TruncateUnavailable();
        if (yield* sessionStore.hasActiveRun(tx, source.id))
          return yield* new SessionBusy();

        const target = history.at(-1);
        if (
          target &&
          (target.info.role !== "assistant" ||
            target.info.time.completed === undefined)
        )
          return yield* new TruncateUnavailable();

        const retainedParts = new Set(
          history.flatMap(({ parts }) => parts.map((part) => part.id)),
        );
        yield* messageStore.truncate(tx, input);
        return yield* sessionStore.update(tx, source.id, {
          anchors:
            source.anchors?.filter((anchor) =>
              retainedParts.has(anchor.partId),
            ) ?? null,
        });
      }),
    (session) =>
      Effect.gen(function* () {
        yield* publisher.publish({ type: "session.updated", session });
        yield* publisher.publish({
          type: "transcript.updated",
          sessionID: session.id,
        });
      }),
  );
});
