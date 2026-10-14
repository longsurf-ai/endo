// Purpose: Generates text-only summary input without replaying full tool payloads.

import type { WithParts } from "@openchart/server/agent/contracts/message";
import type { ToolModelOutput } from "@openchart/server/agent/contracts/part";
import { userModelParts } from "@openchart/server/agent/session/message/model-message-user-parts";

const TOOL_OUTPUT_MAX_CHARS = 2_000;

function truncate(value: string): string {
  return value.length <= TOOL_OUTPUT_MAX_CHARS
    ? value
    : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`;
}

function outputText(output: ToolModelOutput): string {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return JSON.stringify(output.value);
    case "content":
      return output.value
        .map((part) =>
          part.type === "text" ? part.text : `[Attached ${part.mediaType}]`,
        )
        .join("\n");
  }
}

function serialize(message: WithParts): string {
  if (message.info.role === "user") {
    // Reuse OpenChart's quote, document, evidence and plugin framing. Files
    // become descriptions here, including formats normal replay decodes as text.
    const text = userModelParts(
      message.parts.filter(
        (part) => part.type !== "file" && part.type !== "compaction",
      ),
    )
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .filter(Boolean)
      .join("\n");
    const files = message.parts.flatMap((part) =>
      part.type === "file"
        ? [`[Attached ${part.mime}: ${part.filename ?? "file"}]`]
        : [],
    );
    return [...(text ? [`[User]: ${text}`] : []), ...files].join("\n");
  }
  return message.parts
    .flatMap((part) => {
      if (part.type === "text")
        return part.text ? [`[Assistant]: ${part.text}`] : [];
      if (part.type === "reasoning")
        return part.text ? [`[Assistant reasoning]: ${part.text}`] : [];
      if (part.type !== "tool") return [];
      const call = `[Assistant tool call]: ${part.tool}(${JSON.stringify(part.state.input)})`;
      if (part.state.status === "completed") {
        const attachments = (part.state.attachments ?? []).map(
          (item) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`,
        );
        const output = part.state.time.compacted
          ? "[Old tool result content cleared]"
          : truncate(
              [outputText(part.state.output), ...attachments].join("\n"),
            );
        return [call, `[Tool result]: ${output}`];
      }
      if (part.state.status === "error")
        return [call, `[Tool error]: ${part.state.error}`];
      return [call];
    })
    .join("\n");
}

/**
 * Serializes selected history for compaction using 2,000-character
 * tool-result previews and attachment descriptions. Conversation text, reasoning,
 * tool inputs and errors remain intact; execution metadata is not summary input.
 * Text over `maxChars` keeps its two ends and drops the middle, so a prior summary
 * and the latest work survive. It never mutates the transcript; a failed summary
 * therefore leaves original history available.
 * @throws If an evidence-backed user document has not been materialized.
 * @example const conversation = serializeCompactionHistory(messages, 1_000_000);
 */
export function serializeCompactionHistory(
  messages: readonly WithParts[],
  maxChars: number,
): string {
  const text = messages.map(serialize).filter(Boolean).join("\n\n");
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return [
    text.slice(0, half),
    "[Middle of conversation truncated]",
    text.slice(text.length - half),
  ].join("\n\n");
}
