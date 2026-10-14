// Purpose: Commit an observed Run as the Session's monotonic read position.
import { Effect, Schema } from "effect";
import { ID as RunId } from "@openchart/server/agent/run/run";
import { Publisher } from "@openchart/server/agent/publisher/publisher";
import { commit } from "@openchart/server/agent/session/commit";
import { sessionStore } from "@openchart/server/agent/session/store";

/** The client acknowledges a specific displayed result, never unseen newer work. */
export const MarkReadInput = Schema.Struct({
  runId: RunId,
});

/** Advance the owning Session's read position and publish ordinary Session updates. Reject missing or unfinished Runs; stale acknowledgements are no-ops. @example yield* markRead({runId}); */
export const markRead = Effect.fn("Session.markRead")(function* (
  input: typeof MarkReadInput.Type,
) {
  const publisher = yield* Publisher.Service;
  yield* commit(
    (tx) => sessionStore.markRead(tx, input.runId),
    (session) =>
      session
        ? publisher.publish({ type: "session.updated", session })
        : Effect.void,
  );
});
