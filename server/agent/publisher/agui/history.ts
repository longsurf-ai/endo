// Purpose: Projects complete-turn pages with the same message and delegate protocol as live delivery.
import { Session } from "@openchart/server/agent/session";
import type { TranscriptPageInput } from "@openchart/server/agent/session/operations/read-transcript-page";
import { Effect } from "effect";
import { projectTree, readTree } from "./subagents";

/**
 * Reads a page and its linked delegates while the caller holds Events.withBarrier.
 * The result is data to prepend, not a replacement snapshot or a replay of live
 * events. messageInfo/lifecycle/open describe only this page, never Run state.
 * @example const page = yield* events.withBarrier(readHistoryPage({sessionID, cursor}));
 */
export const readHistoryPage = Effect.fn("AGUI.readHistoryPage")(function* (
  input: typeof TranscriptPageInput.Type,
) {
  const sessions = yield* Session.Service;
  const page = yield* sessions.readTranscriptPage(input);
  const tree = yield* readTree(page);
  return { ...projectTree(input.sessionID, tree), nextCursor: page.nextCursor };
});
