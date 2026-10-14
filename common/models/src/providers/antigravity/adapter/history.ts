// Purpose: Converts the AI SDK prompt into the single text message an Antigravity CLI turn accepts.
import type {
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";

export interface AntigravityPrompt {
  /** System messages, joined; the CLI has no system prompt option. */
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

/** Headless input is text only; files are named so the model knows they existed. */
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
export function convertPrompt(
  prompt: LanguageModelV4Prompt,
): AntigravityPrompt {
  let last = prompt.length - 1;
  while (last >= 0 && prompt[last]!.role !== "user") last -= 1;
  if (last < 0)
    throw new Error("Antigravity turns require a final user message");
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
 * Composes the turn's text. A fresh conversation also receives the system
 * instructions and the replayed transcript; a resumed one already holds both.
 * @example const content = turnText(prompt, resume === undefined);
 */
export function turnText(prompt: AntigravityPrompt, fresh: boolean): string {
  if (!fresh) return prompt.input;
  const preface = [
    ...(prompt.system ? [`System instructions:\n${prompt.system}`] : []),
    ...(prompt.replay ? [`Conversation so far:\n\n${prompt.replay}`] : []),
  ];
  if (preface.length === 0) return prompt.input;
  return [...preface, `Human: ${prompt.input}`].join("\n\n");
}
