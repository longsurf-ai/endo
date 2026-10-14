// Purpose: Projects mutable execution details into native AG-UI activities.

import { EventType, type ActivityMessage, type AGUIEvent } from "@ag-ui/core";
import type { ToolPart } from "@openchart/server/agent/contracts/part";
import jsonPatch from "fast-json-patch";
import { toolDelegateSessionId } from "./tool-delegate";

/**
 * Keeps execution progress separate from the already closed argument stream.
 * The same activity identity is used by cold history and live updates.
 * @example
 * const activity = toolActivity(committedTool);
 */
export function toolActivity(part: ToolPart): ActivityMessage {
  const childSessionId = toolDelegateSessionId(part);
  // Only display metadata crosses this boundary; provider envelopes stay stored.
  const details = Object.fromEntries(
    Object.entries(part.state.metadata ?? {}).filter(
      ([key]) => key === "trace" || key === "computerUse",
    ),
  );
  return {
    id: `${part.id}:activity`,
    role: "activity",
    activityType: "openchart.tool",
    content: {
      toolCallId: part.callID,
      status: part.state.status,
      ...(childSessionId === undefined ? {} : { childSessionId }),
      ...(Object.keys(details).length === 0 ? {} : { details }),
      ...("title" in part.state && part.state.title !== undefined
        ? { title: part.state.title }
        : {}),
      ...("attachments" in part.state && part.state.attachments !== undefined
        ? { attachments: part.state.attachments }
        : {}),
    },
  };
}

/**
 * Initializes one activity, then patches only its changed content fields.
 * @example
 * const events = activityEvents(previousActivity, nextActivity);
 */
export function activityEvents(
  previous: ActivityMessage | undefined,
  next: ActivityMessage,
): AGUIEvent[] {
  if (!previous)
    return [
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        replace: true,
        messageId: next.id,
        activityType: next.activityType,
        content: structuredClone(next.content),
        ...(next.metadata === undefined
          ? {}
          : { metadata: structuredClone(next.metadata) }),
      },
    ];
  const patch = jsonPatch.compare(previous.content, next.content);
  return patch.length === 0
    ? []
    : [
        {
          type: EventType.ACTIVITY_DELTA,
          messageId: next.id,
          activityType: next.activityType,
          patch,
        },
      ];
}
