// Purpose: Converts the AI SDK prompt into thread instructions, injected Responses items, and turn input.
import { createHash } from "node:crypto";
import type {
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ToolResultOutput,
} from "@ai-sdk/provider";
import type { UserInput } from "./protocol";

export interface ConvertedPrompt {
  /** System messages, joined; the thread's developer instructions. */
  developerInstructions?: string;
  /** Raw Responses API items preceding the native turn input. */
  history: unknown[];
  /** The final user message, or a continuation cue after replaying host work. */
  input: UserInput[];
}

/** Keeps Responses call IDs within 64 characters, pairing calls/results without mutating history. */
function replayCallId(id: string): string {
  return id.length <= 64 ? id : createHash("sha256").update(id).digest("hex");
}

function fileUrl(part: LanguageModelV4FilePart): string | undefined {
  const data = part.data;
  if (data.type === "url") return String(data.url);
  if (data.type !== "data") return undefined;
  const base64 =
    typeof data.data === "string"
      ? data.data
      : Buffer.from(data.data).toString("base64");
  return `data:${part.mediaType};base64,${base64}`;
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
      return `Tool execution denied${output.reason ? `: ${output.reason}` : ""}`;
    case "content":
      return output.value
        .map((entry) =>
          entry.type === "text" ? entry.text : `[${entry.type}]`,
        )
        .join("\n");
  }
}

function userInput(
  content: Extract<LanguageModelV4Message, { role: "user" }>["content"],
): UserInput[] {
  return content.flatMap((part): UserInput[] => {
    if (part.type === "text")
      return part.text
        ? [{ type: "text", text: part.text, text_elements: [] }]
        : [];
    const url = part.mediaType.startsWith("image/") ? fileUrl(part) : undefined;
    return url
      ? [{ type: "image", url }]
      : [
          {
            type: "text",
            text: `[attachment: ${part.mediaType}]`,
            text_elements: [],
          },
        ];
  });
}

/** Responses API items for one message; Codex appends them to model-visible history. */
function historyItems(message: LanguageModelV4Message): unknown[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return [
        {
          type: "message",
          role: "user",
          content: message.content.map((part) => {
            if (part.type === "text")
              return { type: "input_text", text: part.text };
            const url = part.mediaType.startsWith("image/")
              ? fileUrl(part)
              : undefined;
            return url
              ? { type: "input_image", image_url: url, detail: "auto" }
              : { type: "input_text", text: `[attachment: ${part.mediaType}]` };
          }),
        },
      ];
    case "assistant":
      return message.content.flatMap((part): unknown[] => {
        switch (part.type) {
          case "text":
            return part.text
              ? [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: part.text }],
                  },
                ]
              : [];
          case "tool-call":
            return [
              {
                type: "function_call",
                call_id: replayCallId(part.toolCallId),
                name: part.toolName,
                arguments: JSON.stringify(part.input ?? {}),
              },
            ];
          case "tool-result":
            return [
              {
                type: "function_call_output",
                call_id: replayCallId(part.toolCallId),
                output: toolOutputText(part.output),
              },
            ];
          default:
            return []; // Reasoning and files from any provider stay out of injected history.
        }
      });
    case "tool":
      return message.content.flatMap((part) =>
        part.type === "tool-result"
          ? [
              {
                type: "function_call_output",
                call_id: replayCallId(part.toolCallId),
                output: toolOutputText(part.output),
              },
            ]
          : [],
      );
  }
}

/**
 * A trailing user message is native turn input; everything before is history.
 * When host work follows the user, replay the entire prompt before continuing.
 * Throws when the prompt has no user message, which Codex cannot start a turn from.
 * @example const { developerInstructions, history, input } = convertPrompt(options.prompt);
 */
export function convertPrompt(prompt: LanguageModelV4Prompt): ConvertedPrompt {
  let last = prompt.length - 1;
  while (last >= 0 && prompt[last]!.role !== "user") last -= 1;
  if (last < 0) throw new Error("Codex turns require a final user message");
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
    ...(system ? { developerInstructions: system } : {}),
    history: (endsWithUser ? prompt.slice(0, last) : prompt).flatMap(
      historyItems,
    ),
    input: endsWithUser
      ? userInput(final.content)
      : [
          {
            type: "text",
            text: "Continue from the conversation above.",
            text_elements: [],
          },
        ],
  };
}
