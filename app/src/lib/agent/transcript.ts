// Purpose: Derives one transcript from cached older pages and the live AG-UI snapshot.
import { EventType } from "@ag-ui/core";
import type { TranscriptPage } from "./client";
import type { SessionSnapshot, Subagent } from "./session-store";

/**
 * Prepends oldest-first pages without mutating Query or AG-UI data. Stable IDs
 * deduplicate overlaps, with live messages, headers and invocation state winning.
 * Historical lifecycle describes cards; it is never replayed as live events.
 * @example const snapshot = mergeTranscript(live, query.data?.pages ?? []);
 */
export function mergeTranscript(
  live: SessionSnapshot,
  pages: readonly TranscriptPage[],
): SessionSnapshot {
  if (pages.length === 0) return live;
  const messages = new Map<string, SessionSnapshot["messages"][number]>();
  const messageInfo: TranscriptPage["messageInfo"] = {};
  const subagents: Record<string, Subagent> = {};
  for (const page of [...pages].reverse()) {
    for (const message of page.messages) messages.set(message.id, message);
    Object.assign(messageInfo, page.messageInfo);
    for (const event of page.lifecycle) {
      if (event.type === EventType.SUBAGENT_STARTED) {
        subagents[event.subagentRunId] = { start: event };
      } else if (
        event.type === EventType.SUBAGENT_FINISHED ||
        event.type === EventType.SUBAGENT_ERROR
      ) {
        const child = subagents[event.subagentRunId];
        if (child) subagents[event.subagentRunId] = { ...child, end: event };
      }
    }
  }
  for (const message of live.messages) messages.set(message.id, message);
  return {
    ...live,
    messages: [...messages.values()],
    subagents: { ...subagents, ...live.subagents },
    state: live.state && {
      ...live.state,
      messageInfo: { ...messageInfo, ...live.state.messageInfo },
    },
  };
}
