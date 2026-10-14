// Purpose: Derives tool activity and per-reply presentation from native AG-UI messages.

import { EventType, type Message } from "@ag-ui/core";
import type { ThreadMessageLike } from "@assistant-ui/react";

import type { Subagent } from "@openchart/app/lib/agent/session-store";

import {
  addMessageMetadata,
  type MessageCompletionTimes,
} from "./assistant-ui-message-metadata";
import { prepareCompactionMessages } from "./assistant-ui-compaction";
import { convertMessagesWithUserParts } from "./assistant-ui-user-parts";

/**
 * Filters compaction summaries, converts user Parts through the library converter,
 * adds compaction metadata, associates tool activities, and selects one action
 * bar per user turn. The latest turn waits for execution to end; earlier replies
 * keep their actions while another turn runs. This derives view data only.
 * @example
 * const messages = convertMessages(snapshot.messages);
 */
export function convertMessages(
  messages: readonly Message[],
  isRunning = false,
  subagents: Readonly<Record<string, Subagent>> = {},
  messageInfo: MessageCompletionTimes = {},
  subagentRunId?: string,
): ThreadMessageLike[] {
  // Convert each invocation independently so child output stays under its tool.
  const scoped = messages.filter(
    (message) => message.subagentRunId === subagentRunId,
  );
  const compaction = prepareCompactionMessages(scoped, isRunning, messageInfo);
  const converted = convertMessagesWithUserParts(compaction.messages);
  const withCompaction = converted.map(compaction.addMetadata);
  const presented = attachToolDetails(
    withCompaction,
    messages,
    subagents,
    messageInfo,
    subagentRunId,
  );
  return addMessageMetadata(
    presented,
    messages,
    isRunning,
    subagentRunId === undefined,
    messageInfo,
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectToolActivities(messages: readonly ThreadMessageLike[]) {
  const activities = new Map<string, Record<string, unknown>>();
  const activityMessages = new Set<ThreadMessageLike>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "data" || part.name !== "openchart.tool") continue;
      if (!record(part.data) || typeof part.data.toolCallId !== "string")
        throw new Error("Tool activity must identify its tool call");
      activities.set(part.data.toolCallId, part.data);
      activityMessages.add(message);
    }
  }
  return { activities, activityMessages };
}

function subagentPresentation(
  child: Subagent,
  messages: readonly Message[],
  subagents: Readonly<Record<string, Subagent>>,
  messageInfo: MessageCompletionTimes,
) {
  const error =
    child.end?.type === EventType.SUBAGENT_ERROR
      ? child.end.message
      : undefined;
  const running =
    child.end === undefined ||
    (child.end.type === EventType.SUBAGENT_FINISHED &&
      child.end.outcome?.type === "suspended");
  return {
    id: child.start.subagentRunId,
    name: child.start.name,
    error,
    running,
    messages: convertMessages(
      messages,
      running,
      subagents,
      messageInfo,
      child.start.subagentRunId,
    ),
  };
}

function attachToolDetails(
  converted: readonly ThreadMessageLike[],
  messages: readonly Message[],
  subagents: Readonly<Record<string, Subagent>>,
  messageInfo: MessageCompletionTimes,
  subagentRunId: string | undefined,
) {
  const { activities, activityMessages } = collectToolActivities(converted);
  const children = new Map(
    Object.values(subagents)
      .filter(({ start }) => start.parentSubagentRunId === subagentRunId)
      .map((child) => [child.start.parentToolCallId, child]),
  );
  return converted
    .filter((message) => !activityMessages.has(message))
    .map((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content))
        return message;
      const toolActivities: Record<string, unknown> = {};
      const toolSubagents: Record<string, unknown> = {};
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        const activity = activities.get(part.toolCallId);
        if (activity) toolActivities[part.toolCallId] = activity;
        const child = children.get(part.toolCallId);
        if (child)
          toolSubagents[part.toolCallId] = subagentPresentation(
            child,
            messages,
            subagents,
            messageInfo,
          );
      }
      return {
        ...message,
        metadata: {
          ...message.metadata,
          custom: {
            ...message.metadata?.custom,
            ...(Object.keys(toolActivities).length === 0
              ? {}
              : { toolActivities }),
            ...(Object.keys(toolSubagents).length === 0
              ? {}
              : { toolSubagents }),
          },
        },
      };
    });
}
