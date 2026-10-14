// Purpose: Present persisted compaction boundaries without exposing internal summaries.
import type { Message } from "@ag-ui/core";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { z } from "zod";
import type { MessageCompletionTimes } from "./assistant-ui-message-metadata";

const Metadata = z.object({
  parts: z.array(z.object({ type: z.string() })).optional(),
  openchart: z.object({ messageId: z.string().optional() }).optional(),
});

/**
 * Filters internal summaries before conversion and prepares marker metadata
 * to add afterwards. The caller owns message conversion and composition.
 * Completion comes only from the durable summary seal; running is derived from
 * the current turn. Failed attempts cannot become successful labels on reload.
 * @example const { messages: visible, addMetadata } = prepareCompactionMessages(messages, running, headers);
 */
export function prepareCompactionMessages(
  messages: readonly Message[],
  isRunning: boolean,
  messageInfo: MessageCompletionTimes,
) {
  const metadata = new Map(
    messages.map((message) => [
      message.id,
      Metadata.parse(message.metadata ?? {}),
    ]),
  );
  const markers = new Set(
    messages
      .filter(
        (message) =>
          message.role === "user" &&
          metadata
            .get(message.id)
            ?.parts?.some((part) => part.type === "compaction"),
      )
      .map((message) => message.id),
  );
  const summaries = Object.entries(messageInfo).flatMap(([id, info]) =>
    "compaction" in info &&
    info.compaction &&
    markers.has(info.compaction.userMessageId)
      ? [{ id, info, userMessageId: info.compaction.userMessageId }]
      : [],
  );
  const summaryIds = new Set(summaries.map(({ id }) => id));
  const byMarker = new Map(
    summaries.map((summary) => [summary.userMessageId, summary]),
  );
  // Automatic continuation inputs have no display content; they do not end
  // the pending compaction while its final seal is being committed.
  const latestUser = messages
    .filter(
      (message) =>
        message.role === "user" &&
        (markers.has(message.id) || !!message.content?.length),
    )
    .at(-1)?.id;
  return {
    messages: messages.filter(
      (message) =>
        !summaryIds.has(metadata.get(message.id)?.openchart?.messageId ?? ""),
    ),
    /**
     * Adds compaction status and the canonical edit boundary to one converted message.
     * @example const annotated = converted.map(compaction.addMetadata);
     */
    addMetadata: (message: ThreadMessageLike): ThreadMessageLike => {
      if (!message.id || !markers.has(message.id)) return message;
      const summary = byMarker.get(message.id);
      const info = summary?.info;
      const compaction = info?.compaction?.summary
        ? "complete"
        : isRunning &&
            latestUser === message.id &&
            !info?.error &&
            (!info?.finish || info.finish === "stop")
          ? "running"
          : "incomplete";
      return {
        ...message,
        metadata: {
          ...message.metadata,
          custom: {
            ...message.metadata?.custom,
            compaction,
            // Editing the next user turn must retain the hidden summary.
            sourceMessageId: summary?.id ?? message.id,
          },
        },
      };
    },
  };
}
