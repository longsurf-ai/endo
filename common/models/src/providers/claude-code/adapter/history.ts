// Purpose: Converts the AI SDK prompt into a system prompt, replayed transcript, and the final Claude user message.
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type Content = SDKUserMessage["message"]["content"];
type ContentBlock = Exclude<Content, string>[number];

export interface ClaudePrompt {
  /** System messages, joined; appended to Claude Code's own system prompt. */
  system?: string;
  /** Complete transcript preceding the native turn input. */
  replay: string;
  /** The final user message, or a continuation cue after replaying host work. */
  input: ContentBlock[];
}

function toolOutputText(output: LanguageModelV4ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return `Execution denied${output.reason ? `: ${output.reason}` : ""}`;
    case "content":
      return output.value
        .map((entry) =>
          entry.type === "text" ? entry.text : `[${entry.type}]`,
        )
        .join("\n");
  }
}

/** Images become native image blocks; other files are named so the model knows they existed. */
function fileBlock(part: LanguageModelV4FilePart): ContentBlock {
  const placeholder: ContentBlock = {
    type: "text",
    text: `[attachment: ${part.mediaType}]`,
  };
  if (!part.mediaType.startsWith("image/")) return placeholder;
  const { data } = part;
  if (data.type === "url")
    return { type: "image", source: { type: "url", url: String(data.url) } };
  if (data.type !== "data") return placeholder;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: part.mediaType as "image/png",
      data:
        typeof data.data === "string"
          ? data.data
          : Buffer.from(data.data).toString("base64"),
    },
  };
}

/** One prior message as transcript lines; reasoning and files stay out. */
function transcript(message: LanguageModelV4Message): string[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return [
        `Human: ${message.content
          .map((part) =>
            part.type === "text"
              ? part.text
              : `[attachment: ${part.mediaType}]`,
          )
          .join("\n")}`,
      ];
    case "assistant":
      return message.content.flatMap((part) => {
        switch (part.type) {
          case "text":
            return part.text ? [`Assistant: ${part.text}`] : [];
          case "tool-call":
            return [
              `[Tool call: ${part.toolName}(${JSON.stringify(part.input ?? {})})]`,
            ];
          case "tool-result":
            return [
              `[Tool result: ${part.toolName} -> ${toolOutputText(part.output)}]`,
            ];
          default:
            return [];
        }
      });
    case "tool":
      return message.content.flatMap((part) =>
        part.type === "tool-result"
          ? [
              `[Tool result: ${part.toolName} -> ${toolOutputText(part.output)}]`,
            ]
          : [],
      );
  }
}

/**
 * A trailing user message becomes native content; everything before is replayed.
 * When host work follows the user, replay the entire prompt before continuing.
 * Throws when no user message exists. Tool values are never silently truncated.
 * @example const { system, replay, input } = convertPrompt(options.prompt);
 */
export function convertPrompt(prompt: LanguageModelV4Prompt): ClaudePrompt {
  let last = prompt.length - 1;
  while (last >= 0 && prompt[last]!.role !== "user") last -= 1;
  if (last < 0) throw new Error("Claude turns require a final user message");
  const system = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const final = prompt[last] as Extract<
    LanguageModelV4Message,
    { role: "user" }
  >;
  const endsWithUser = last === prompt.length - 1;
  return {
    ...(system ? { system } : {}),
    replay: (endsWithUser ? prompt.slice(0, last) : prompt)
      .flatMap(transcript)
      .join("\n\n"),
    input: endsWithUser
      ? final.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : fileBlock(part),
        )
      : [{ type: "text", text: "Continue from the conversation above." }],
  };
}

/**
 * Composes the user message for one query: the replayed transcript, when the
 * session is fresh and history exists, precedes the final message.
 * @example const content = userContent(prompt, replayHistory);
 */
export function userContent(
  prompt: ClaudePrompt,
  replayHistory: boolean,
): ContentBlock[] {
  if (!replayHistory || !prompt.replay) return prompt.input;
  return [
    {
      type: "text",
      text: `Conversation so far:\n\n${prompt.replay}\n\nHuman:`,
    },
    ...prompt.input,
  ];
}
