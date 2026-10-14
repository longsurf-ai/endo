// Purpose: Restores native provenance and selects final reply parts for layout and actions.

import type { Message } from "@ag-ui/core";
import {
  fromThreadMessageLike,
  type ThreadMessageLike,
} from "@assistant-ui/react";

/** Existing message headers: users have no completion time; pending assistants have null. */
export type MessageCompletionTimes = Readonly<
  Record<
    string,
    | { model: unknown }
    | {
        completedAt?: number | null;
        error?: unknown;
        finish?: string | null;
        compaction?: { userMessageId: string; summary: boolean };
        workspaceRoot?: string;
      }
  >
>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Text, reasoning and result messages carry provenance on the message. A tool
// call carries it on the call, where the projection and TOOL_CALL_START put it.
function sourceOf(message: Message) {
  const own = record(message.metadata) ? message.metadata.openchart : undefined;
  if (record(own)) return own;
  const call =
    message.role === "assistant" ? message.toolCalls?.[0] : undefined;
  const callMetadata = call?.metadata;
  const fromCall = record(callMetadata) ? callMetadata.openchart : undefined;
  return record(fromCall) ? fromCall : undefined;
}

function finalReplies(
  messages: readonly ThreadMessageLike[],
  isRunning: boolean,
) {
  const replies = new Map<ThreadMessageLike, number>();
  let reply: { message: ThreadMessageLike; part: number } | undefined;
  // A user message starts a turn, even when one reply spans several model steps.
  for (const message of messages) {
    if (message.role === "user") {
      if (reply) replies.set(reply.message, reply.part);
      reply = undefined;
      continue;
    }
    if (message.role !== "assistant") continue;
    // Match the runtime's part positions without duplicating its normalization.
    // Only content is consumed; fallback message identity/status are not projected.
    const { content: parts } = fromThreadMessageLike(message, "", {
      type: "complete",
      reason: "unknown",
    });
    parts.forEach((part, partIndex) => {
      if (
        part.type === "tool-call" ||
        part.type === "reasoning" ||
        part.type === "data"
      ) {
        reply = undefined;
      } else if (part.type === "text" && part.text.trim()) {
        // Keep only the final text segment; preceding commentary belongs to work.
        if (reply?.message !== message) reply = { message, part: partIndex };
      }
    });
  }
  if (!isRunning && reply) replies.set(reply.message, reply.part);
  return replies;
}

/**
 * Project native timestamps as JSON numbers and restore source IDs, reading a
 * tool call's provenance from the call itself so a turn that starts or ends
 * with a tool call still has a duration.
 * finalReplyStartIndex identifies the final text segment on its message;
 * reply actions derive from the same result.
 * A running latest turn has no final reply. Tool activity must be grouped first.
 * Selects replies before copying messages and leaves the input untouched.
 * @example const presented = addMessageMetadata(converted, messages, false, true, messageInfo);
 */
export function addMessageMetadata(
  converted: readonly ThreadMessageLike[],
  messages: readonly Message[],
  isRunning: boolean,
  showReplyActions: boolean,
  messageInfo: MessageCompletionTimes,
) {
  const replies = finalReplies(converted, isRunning);
  const sources = new Map(
    messages.map((message) => [message.id, sourceOf(message)]),
  );
  return converted.map((message) => {
    // Decide before copying the message: finalReplies tracks object identity.
    const finalReplyStartIndex = replies.get(message);
    const showActions = showReplyActions && finalReplyStartIndex !== undefined;
    const source = sources.get(message.id ?? "");
    const info =
      typeof source?.messageId === "string"
        ? messageInfo[source.messageId]
        : undefined;
    const createdAt = source?.createdAt;
    if (typeof createdAt === "number") {
      message = {
        ...message,
        metadata: {
          ...message.metadata,
          custom: { ...message.metadata?.custom, sourceCreatedAt: createdAt },
        },
      };
    }
    if (message.role !== "assistant") return message;
    return {
      ...message,
      metadata: {
        ...message.metadata,
        custom: {
          ...message.metadata?.custom,
          finalReplyStartIndex,
          showActions,
          sourceMessageId: source?.messageId,
          workspaceRoot:
            info && "workspaceRoot" in info ? info.workspaceRoot : undefined,
          sourceCompletedAt:
            info && "completedAt" in info ? info.completedAt : undefined,
        },
      },
    };
  });
}

/**
 * Materialize native dates at assistant-ui's cached per-message conversion boundary.
 * Keep the preceding projection JSON-compatible so unchanged messages can share
 * references even when AG-UI emits cloned snapshots. Missing dates use the
 * runtime's own fallback, which its message cache retains across text deltas.
 * @example useExternalStoreRuntime({ messages, convertMessage: toAssistantUiMessage });
 */
export function toAssistantUiMessage(
  message: ThreadMessageLike,
): ThreadMessageLike {
  const createdAt = message.metadata?.custom?.sourceCreatedAt;
  return typeof createdAt === "number"
    ? { ...message, createdAt: new Date(createdAt) }
    : message;
}
