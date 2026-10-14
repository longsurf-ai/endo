// Purpose: Selects committed prompt history and recognizes completed user turns.

import type {
  Assistant,
  User,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import { Session } from "@openchart/server/agent/session/session";
import { assertExists, assertTrue } from "@openchart/utils/assert";
import { Effect } from "effect";

/**
 * Finds the newest User, Assistant, and finished Assistant in storage order.
 * These anchors may belong to different turns; IDs and timestamps never decide
 * which message is newest. The input history is not copied or modified.
 * @example
 * const {lastUser, lastAssistant, lastFinished} = derivePromptLoopAnchors(messages);
 */
export function derivePromptLoopAnchors(messages: readonly WithParts[]) {
  let lastUser: User | undefined;
  let lastAssistant: Assistant | undefined;
  let lastFinished: Assistant | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    assertExists(
      message,
      "Prompt history must contain a message at each index",
    );
    const info = message.info;
    if (info.role === "user") lastUser ??= info;
    if (info.role === "assistant") {
      lastAssistant ??= info;
      if (info.finish) lastFinished ??= info;
    }
    if (lastUser && lastFinished) break;
  }
  return { lastUser, lastAssistant, lastFinished };
}

/**
 * Copies replay history and marks new user text after the last finished step.
 * Reminders are ephemeral: committed text and synthetic Parts
 * remain unchanged. The finished anchor must belong to the supplied history.
 * @example
 * const history = prepareStepHistory({messages, lastFinished, step: 2});
 */
export function prepareStepHistory(input: {
  messages: readonly WithParts[];
  lastFinished?: Assistant;
  step: number;
}): WithParts[] {
  const history = structuredClone([...input.messages]);
  if (input.step <= 1 || !input.lastFinished) return history;
  const boundary = history.findIndex(
    (message) => message.info.id === input.lastFinished?.id,
  );
  assertTrue(
    boundary >= 0,
    "The finished anchor must belong to prompt history",
  );
  for (const message of history.slice(boundary + 1)) {
    if (message.info.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type !== "text" || part.synthetic || !part.text.trim()) continue;
      part.text = [
        "<system-reminder>",
        "The user sent the following message:",
        part.text,
        "",
        "Please address this message and continue with your tasks.",
        "</system-reminder>",
      ].join("\n");
    }
  }
  return history;
}

/**
 * Recognizes a sealed, successful summary with model-visible text.
 * Failed, interrupted, empty, and output-limited attempts never hide history.
 * @example
 * if (isUsableSummary(message)) retainItsCompactionBoundary(message);
 */
export function isUsableSummary(
  message: WithParts,
): message is WithParts & { info: Assistant } {
  return (
    message.info.role === "assistant" &&
    message.info.agent === "compaction" &&
    message.info.summary === true &&
    message.info.finish === "stop" &&
    !message.info.error &&
    message.parts.some(
      (part) => part.type === "text" && part.text.trim().length > 0,
    )
  );
}

/**
 * Reads oldest-first history through the latest valid compaction boundary.
 * The marker remains included; unsuccessful summary content is excluded. Pagination
 * uses storage cursors, never message ID ordering or content timestamps.
 * @example
 * const messages = yield* readHistory(sessionID);
 */
export const readHistory = Effect.fn("Prompt.readHistory")(function* (
  sessionID: string,
) {
  const session = yield* Session.Service;
  const result: WithParts[] = [];
  const summaries = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = yield* session.listMessages({ sessionID, cursor, limit: 100 });
    for (const message of [...page.items].reverse()) {
      const usable = isUsableSummary(message);
      result.push(message);
      if (usable) summaries.add(message.info.triggeringUserMessageID);
      if (
        message.info.role === "user" &&
        summaries.has(message.info.id) &&
        message.parts.some((part) => part.type === "compaction")
      )
        return visibleHistory(result);
    }
    if (page.nextCursor === null) return visibleHistory(result);
    cursor = page.nextCursor;
  }
});

function visibleHistory(messages: WithParts[]): WithParts[] {
  const markers = new Set(
    messages
      .filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "compaction"),
      )
      .map((message) => message.info.id),
  );
  // The marker identifies compaction work. A direct prompt using the same
  // profile is an ordinary turn and must remain visible to completion checks.
  return messages.reverse().map((message) => {
    if (
      message.info.role !== "assistant" ||
      message.info.agent !== "compaction" ||
      !markers.has(message.info.triggeringUserMessageID) ||
      isUsableSummary(message)
    )
      return message;
    // Every compaction attempt retains its execution boundary. Only usable
    // summaries contribute content to model replay.
    return { ...message, parts: [] };
  });
}

/**
 * Identifies a finished natural reply to this user, independent of ID ordering.
 * Tool-call and unknown finishes require another loop iteration.
 * @example
 * if (isNaturalReplyForUser(user.id, assistant)) return;
 */
export function isNaturalReplyForUser(
  userID: string,
  assistant?: Pick<Assistant, "finish" | "triggeringUserMessageID">,
): boolean {
  return (
    !!assistant?.finish &&
    assistant.finish !== "tool-calls" &&
    assistant.finish !== "unknown" &&
    assistant.triggeringUserMessageID === userID
  );
}
