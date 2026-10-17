// Purpose: Converts the AI SDK prompt into Grok session rules and the text of one ACP prompt.
import type {
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";

export interface GrokPrompt {
  /** System messages, joined; sent as session rules on `session/new`. */
  system?: string;
  /** Complete transcript preceding the turn input. */
  replay: string;
  /** The final user message, or a continuation cue after replaying host work. */
  input: string;
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

/** ACP turns accept text only here; files are named so the model knows they existed. */
function userText(
  message: Extract<LanguageModelV4Message, { role: "user" }>,
): string {
  return message.content
    .map((part) =>
      part.type === "text" ? part.text : `[attachment: ${part.mediaType}]`,
    )
    .join("\n");
}

/** One prior message as transcript lines; reasoning stays out. */
function transcript(message: LanguageModelV4Message): string[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return [`Human: ${userText(message)}`];
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
 * A trailing user message becomes the turn input; everything before is replayed.
 * When host work follows the user, the entire prompt is replayed before a
 * continuation cue. Throws when no user message exists. Tool values are never
 * silently truncated.
 * @example const { system, replay, input } = convertPrompt(options.prompt);
 */
export function convertPrompt(prompt: LanguageModelV4Prompt): GrokPrompt {
  let last = prompt.length - 1;
  while (last >= 0 && prompt[last]!.role !== "user") last -= 1;
  if (last < 0) throw new Error("Grok turns require a final user message");
  const system = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const endsWithUser = last === prompt.length - 1;
  return {
    ...(system ? { system } : {}),
    replay: (endsWithUser ? prompt.slice(0, last) : prompt)
      .flatMap(transcript)
      .join("\n\n"),
    input: endsWithUser
      ? userText(
          prompt[last] as Extract<LanguageModelV4Message, { role: "user" }>,
        )
      : "Continue from the conversation above.",
  };
}

/**
 * The turn's ACP content blocks. A fresh session also receives the replayed
 * transcript; a resumed one already holds it. Grok runs a leading `/word` as
 * a slash command, so the text follows an empty block, which keeps it literal.
 * @example const prompt = promptBlocks(converted, resume === undefined);
 */
export function promptBlocks(
  prompt: GrokPrompt,
  fresh: boolean,
): Array<{ type: "text"; text: string }> {
  const text =
    fresh && prompt.replay
      ? `Conversation so far:\n\n${prompt.replay}\n\nHuman: ${prompt.input}`
      : prompt.input;
  return [
    { type: "text", text: "" },
    { type: "text", text },
  ];
}
