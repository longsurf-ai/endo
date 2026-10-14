import { Question } from "@openchart/server/agent/question";
import { Permission } from "@openchart/server/agent/permission";
import { AgentRunStore } from "@openchart/server/agent/run/store";
import {
  SessionState,
  projectRuns,
} from "@openchart/server/agent/session/state";
import { readTranscriptPage } from "./read-transcript-page";
import { Effect } from "effect";

/**
 * Reads the latest complete-turn window while the caller holds Events.withBarrier.
 * Includes visible Messages and Parts, Session metadata, Run summaries, and pending
 * approvals. Transcript visibility and pagination belong to readTranscriptPage.
 * Pending permissions retain their process-local owner; reading them never
 * acquires its mutation lock. This function acquires no barrier and does not
 * register an observer.
 * @example
 * const snapshot = yield* events.withBarrier(readSnapshot(sessionID));
 */
export const readSnapshot = Effect.fn("Session.readSnapshot")(function* (
  sessionID: string,
) {
  const runs = yield* AgentRunStore.Service;
  const permission = yield* Permission.Service;
  const question = yield* Question.Service;
  const { session, history, nextCursor } = yield* readTranscriptPage({
    sessionID,
  });
  const state: typeof SessionState.Type = {
    session,
    runs: projectRuns(yield* runs.list(sessionID)),
    permissions: yield* permission.list(sessionID),
    questions: yield* question.list(sessionID),
  };
  return { history, state, nextCursor };
});
