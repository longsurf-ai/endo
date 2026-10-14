// Purpose: Projects committed transcript facts into native AG-UI messages for history and live delivery.

import {
  EventType,
  type AGUIEvent,
  type Message as AgUiMessage,
  type ToolMessage,
} from "@ag-ui/core";
import type {
  MessageInfo,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import type {
  ContextPart,
  Part,
  ToolPart,
} from "@openchart/server/agent/contracts/part";
import { assertTrue } from "@openchart/utils/assert";
import { visibleTextPart } from "@openchart/server/agent/session/message/visibility";
import { isDeepStrictEqual } from "node:util";
import { activityEvents, toolActivity } from "./activity";

// Quote and Dig In render as structured tiles from metadata.parts, and plugin
// context is model-only; the remaining contexts read as plain bubble text.
function contextText({ context }: ContextPart): string | undefined {
  switch (context.kind) {
    case "plugin":
    case "quote":
    case "dig_in":
      return undefined;
    case "document":
      return context.title;
    case "resource":
      return `${context.resource}: ${context.id}`;
    case "session":
      return `Session: ${context.sessionId}`;
  }
}

// The user bubble's text. Attachments, quotes, and workflows stay structured in
// metadata.parts, so the same message can travel as one native text message.
function userText(parts: readonly Part[]): string {
  return parts
    .flatMap((part) => {
      if (part.type === "text") return visibleTextPart(part) ? [part.text] : [];
      if (part.type !== "context") return [];
      const text = contextText(part);
      return text === undefined ? [] : [text];
    })
    .join("\n");
}

function sourceMetadata(info: MessageInfo, part?: Part) {
  return {
    openchart: {
      messageId: info.id,
      ...(part === undefined ? {} : { partId: part.id }),
      createdAt: info.time.created,
    },
  };
}

function toolResult(
  info: MessageInfo,
  part: ToolPart,
): ToolMessage | undefined {
  const { state } = part;
  if (state.status !== "completed" && state.status !== "error")
    return undefined;
  const content =
    state.status === "error"
      ? state.error
      : state.output.type === "text"
        ? state.output.value
        : JSON.stringify(state.output.value);
  return {
    id: `${part.id}:result`,
    role: "tool",
    toolCallId: part.callID,
    content:
      state.status === "completed" && content.length > 500
        ? `${content.slice(0, 500)}\n… [truncated]`
        : content,
    metadata: sourceMetadata(info, part),
    ...(state.status === "error" ? { error: state.error } : {}),
  };
}

// Call/result content is compared independently from mutable execution Activity.
function toolMessages(info: MessageInfo, part: ToolPart): AgUiMessage[] {
  const metadata = sourceMetadata(info, part);
  const messages: AgUiMessage[] = [
    {
      id: part.id,
      role: "assistant",
      toolCalls: [
        {
          id: part.callID,
          type: "function",
          function: {
            name: part.tool,
            arguments:
              part.state.status === "pending"
                ? ""
                : JSON.stringify(part.state.input),
          },
          metadata,
        },
      ],
    },
  ];
  const result = toolResult(info, part);
  if (result !== undefined) messages.push(result);
  return messages;
}

/**
 * Projects one committed Assistant Part without mutating or sharing its objects.
 * Part IDs remain message IDs so selection offsets and child-session anchors
 * survive streaming, cold starts, and tool/text interleaving.
 * @example
 * const messages = projectPart(assistant, committedTextPart);
 */
export function projectPart(info: MessageInfo, part: Part): AgUiMessage[] {
  assertTrue(info.id === part.messageID, "Part belongs to a different message");
  assertTrue(
    info.role === "assistant",
    "User Parts project as one complete message",
  );
  let messages: AgUiMessage[];
  switch (part.type) {
    case "text":
      messages = visibleTextPart(part)
        ? [
            {
              id: part.id,
              role: "assistant",
              content: part.text.trimEnd(),
              metadata: sourceMetadata(info, part),
            },
          ]
        : [];
      break;
    case "reasoning":
      messages = [
        {
          id: part.id,
          role: "reasoning",
          content: part.text.trimEnd(),
          metadata: sourceMetadata(info, part),
        },
      ];
      break;
    case "tool":
      messages = [...toolMessages(info, part), toolActivity(part)];
      break;
    case "step-start":
    case "step-finish":
    case "compaction":
    case "evidence":
      messages = [];
      break;
    default:
      messages = [
        {
          id: part.id,
          role: "activity",
          activityType: `openchart.${part.type}`,
          content: part,
          metadata: sourceMetadata(info, part),
        },
      ];
  }
  return structuredClone(messages);
}

/**
 * Projects one complete committed message in canonical Part order. User text,
 * attachments, and contexts stay in one native user message; Assistant Parts
 * remain individually addressable and retain their interleaved order.
 * @example
 * const messages = projectMessage(await readMessage());
 */
export function projectMessage(message: WithParts): AgUiMessage[] {
  const parts = message.parts
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (message.info.role === "assistant")
    return parts.flatMap((part) => projectPart(message.info, part));
  return [
    {
      id: message.info.id,
      role: "user",
      content: userText(parts),
      metadata: {
        ...sourceMetadata(message.info),
        // Native metadata retains the structured context and source IDs for
        // custom views without a second, bespoke transcript store.
        parts: structuredClone(
          parts.filter((part) => part.type !== "text" || visibleTextPart(part)),
        ),
      },
    },
  ];
}

/**
 * Appends one committed user message with the history projection, so live
 * observers and cold pages agree without a snapshot. The bubble text is one
 * delta; structure rides in START metadata, which the community reducer merges.
 * @example
 * const events = userMessageEvents(committedUserMessage);
 */
export function userMessageEvents(message: WithParts): AGUIEvent[] {
  const projected = projectMessage(message)[0];
  assertTrue(
    projected?.role === "user" && typeof projected.content === "string",
    "User messages project as one text message",
  );
  const events: AGUIEvent[] = [
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: projected.id,
      role: "user",
      metadata: projected.metadata,
    },
  ];
  if (projected.content.length > 0)
    events.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: projected.id,
      delta: projected.content,
    });
  events.push({ type: EventType.TEXT_MESSAGE_END, messageId: projected.id });
  return events;
}

/**
 * Projects an oldest-first transcript page whose visibility was resolved by Session.
 * @example
 * const messages = projectTranscript(history);
 */
export function projectTranscript(
  history: readonly WithParts[],
): AgUiMessage[] {
  return history.flatMap(projectMessage);
}

function startEvents(info: MessageInfo, part: Part): AGUIEvent[] {
  switch (part.type) {
    case "text":
      return visibleTextPart(part)
        ? [
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: part.id,
              role: "assistant",
              metadata: sourceMetadata(info, part),
            },
          ]
        : [];
    case "reasoning":
      return [
        { type: EventType.REASONING_START, messageId: part.id },
        {
          type: EventType.REASONING_MESSAGE_START,
          messageId: part.id,
          role: "reasoning",
          metadata: sourceMetadata(info, part),
        },
      ];
    case "tool":
      return [
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: part.callID,
          toolCallName: part.tool,
          parentMessageId: part.id,
          metadata: sourceMetadata(info, part),
        },
      ];
    default:
      return [];
  }
}

/**
 * Derives native events from a committed Part transition. Undefined asks the
 * caller for a full transcript snapshot when an append cannot represent a
 * replacement. Normal execution details use independent Activity updates;
 * terminal results are emitted once and never used as a metadata upsert.
 * @example
 * const events = partEvents(assistant, previousPart, committedPart);
 * if (events === undefined) publishTranscriptSnapshot();
 */
export function partEvents(
  info: MessageInfo,
  previous: Part | undefined,
  next: Part,
): AGUIEvent[] | undefined {
  assertTrue(info.id === next.messageID, "Part belongs to a different message");
  if (info.role !== "assistant") return undefined;
  if (previous !== undefined) {
    assertTrue(
      previous.id === next.id && previous.type === next.type,
      "Part identity and type cannot change",
    );
  }
  if (next.type === "text" || next.type === "reasoning") {
    const before =
      previous?.type === "text" || previous?.type === "reasoning"
        ? previous
        : undefined;
    if (next.type === "text" && !visibleTextPart(next)) {
      return before !== undefined && visibleTextPart(before) ? undefined : [];
    }
    if (before?.type === "text" && !visibleTextPart(before)) return undefined;
    // Do not publish suffix whitespace that finalization will retract.
    const oldText = before?.text.trimEnd() ?? "";
    const text = next.text.trimEnd();
    if (!text.startsWith(oldText)) return undefined;
    const delta = text.slice(oldText.length);
    if (before?.time?.end !== undefined && delta.length > 0) return undefined;
    const events = before === undefined ? startEvents(info, next) : [];
    if (delta.length > 0)
      events.push({
        type:
          next.type === "text"
            ? EventType.TEXT_MESSAGE_CONTENT
            : EventType.REASONING_MESSAGE_CONTENT,
        messageId: next.id,
        delta,
      });
    events.push(...partCompletionEvents(info, previous, next));
    return structuredClone(events);
  }
  if (next.type === "tool") {
    const before = previous?.type === "tool" ? previous : undefined;
    if (
      before !== undefined &&
      (before.callID !== next.callID || before.tool !== next.tool)
    )
      return undefined;
    if (
      before?.state.status === "completed" ||
      before?.state.status === "error"
    ) {
      const oldMessages = toolMessages(info, before);
      const newMessages = toolMessages(info, next);
      return isDeepStrictEqual(oldMessages, newMessages)
        ? activityEvents(toolActivity(before), toolActivity(next))
        : undefined;
    }
    const events = before === undefined ? startEvents(info, next) : [];
    if (
      next.state.status !== "pending" &&
      (before === undefined || before.state.status === "pending")
    ) {
      events.push(
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: next.callID,
          delta: JSON.stringify(next.state.input),
          metadata: sourceMetadata(info, next),
        },
        { type: EventType.TOOL_CALL_END, toolCallId: next.callID },
      );
    } else if (
      before !== undefined &&
      JSON.stringify(before.state.input) !== JSON.stringify(next.state.input)
    ) {
      return undefined;
    }
    const result = toolResult(info, next);
    if (result !== undefined) {
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: result.id,
        toolCallId: next.callID,
        role: "tool",
        content: result.content,
        metadata: result.metadata,
        ...(result.error === undefined ? {} : { error: result.error }),
      });
    }
    events.push(
      ...activityEvents(
        before === undefined ? undefined : toolActivity(before),
        toolActivity(next),
      ),
    );
    return structuredClone(events);
  }
  if (next.type === "step-start")
    return previous === undefined
      ? [{ type: EventType.STEP_STARTED, stepName: info.id }]
      : [];
  const projected = projectPart(info, next);
  const activity = projected.find((message) => message.role === "activity");
  if (activity) {
    const before =
      previous === undefined
        ? undefined
        : projectPart(info, previous).find(
            (message) => message.role === "activity",
          );
    return activityEvents(before, activity);
  }
  return [];
}

/**
 * Closes a newly finished text/reasoning Part, including a replacement that
 * requires a snapshot. Emit these events before that replacement snapshot so
 * the existing message can close even if its new projection is hidden.
 * @example
 * if (partEvents(info, previous, next) === undefined) {
 *   publish(partCompletionEvents(info, previous, next));
 *   publishTranscriptSnapshot();
 * }
 */
export function partCompletionEvents(
  info: MessageInfo,
  previous: Part | undefined,
  next: Part,
): AGUIEvent[] {
  if (
    info.role !== "assistant" ||
    (next.type !== "text" && next.type !== "reasoning")
  )
    return [];
  if (next.time?.end === undefined) return [];
  if (previous?.type === "text" || previous?.type === "reasoning") {
    if (previous.time?.end !== undefined) return [];
    if (previous.type === "text" && !visibleTextPart(previous)) return [];
  } else if (next.type === "text" && !visibleTextPart(next)) return [];
  const events: AGUIEvent[] = [
    {
      type:
        next.type === "text"
          ? EventType.TEXT_MESSAGE_END
          : EventType.REASONING_MESSAGE_END,
      messageId: next.id,
      metadata: sourceMetadata(info, next),
    },
  ];
  if (next.type === "reasoning")
    events.push({ type: EventType.REASONING_END, messageId: next.id });
  return structuredClone(events);
}

/**
 * Reopens only unfinished Part streams after a cold-start snapshot. It sends
 * no text or arguments, so the community reducer retains snapshot content.
 * The caller must open the actual durable Run before these events.
 * @example
 * const events = activePartEvents(history);
 */
export function activePartEvents(history: readonly WithParts[]): AGUIEvent[] {
  return history.flatMap(({ info, parts }) => {
    if (info.role !== "assistant" || info.time.completed !== undefined)
      return [];
    return parts.flatMap((part) => {
      const active =
        part.type === "tool"
          ? part.state.status === "pending"
          : (part.type === "text" || part.type === "reasoning") &&
            part.time?.end === undefined;
      return active ? structuredClone(startEvents(info, part)) : [];
    });
  });
}
