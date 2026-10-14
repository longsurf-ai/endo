// Purpose: Owns the public Agent shared-state projection and its derived type.

import { EventType, type AGUIEvent } from "@ag-ui/core";
import type {
  MessageInfo,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import type { SessionState } from "@openchart/server/agent/session/state";

/**
 * Selects the user's saved model/workspace or Assistant completion facts and execution root.
 * Internal requests and Parts remain with their owners.
 * @example
 * const header = messageInfoState(committedMessage);
 */
export function messageInfoState(info: MessageInfo) {
  return info.role === "user"
    ? {
        model: structuredClone(info.model),
        workspaceId: info.workspaceId,
      }
    : {
        workspaceRoot: info.path.cwd,
        completedAt: info.time.completed ?? null,
        error: info.error ?? null,
        finish: info.finish ?? null,
        cost: info.cost,
        tokens: structuredClone(info.tokens),
        ...(info.agent === "compaction"
          ? {
              compaction: {
                userMessageId: info.triggeringUserMessageID,
                summary: info.summary === true,
              },
            }
          : {}),
      };
}

/**
 * Adds the same message headers that incremental events maintain after bootstrap.
 * @example
 * const initial = projectState(history, sessionState);
 */
export function projectState(
  history: readonly WithParts[],
  state: typeof SessionState.Type,
  nextCursor: string | null = null,
) {
  return {
    ...state,
    messageInfo: projectMessageInfo(history),
    history: { nextCursor },
  };
}

/** Public Agent state follows the snapshot projection without a second shape. */
export type AgentSessionState = ReturnType<typeof projectState>;

/**
 * Projects visible message headers indexed by their domain Message ID.
 * @example
 * const headers = projectMessageInfo(history);
 */
export function projectMessageInfo(history: readonly WithParts[]) {
  const headers: Record<string, ReturnType<typeof messageInfoState>> = {};
  for (const { info } of history) {
    headers[info.id] = messageInfoState(info);
  }
  return headers;
}

/**
 * Updates one message header without rewriting text, tools or reasoning.
 * Publish User headers only to their own Session so delegate input stays private.
 * @example
 * const event = messageInfoEvent(assistant);
 */
export function messageInfoEvent(info: MessageInfo): AGUIEvent[] {
  return [
    {
      type: EventType.STATE_DELTA,
      delta: [
        {
          op: "add",
          path: `/messageInfo/${info.id.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          value: messageInfoState(info),
        },
      ],
    },
  ];
}
