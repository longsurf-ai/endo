// Purpose: Replays authoritative Endo history without treating it as a native command.
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";

/**
 * Keeps role, call IDs and complete tool values in a fresh native transcript.
 * Reasoning is private and omitted. Attachments fail explicitly in this text-only
 * adapter. A literal prefix prevents native slash-command interpretation.
 * @example const prompt = convertPrompt(call.prompt, false);
 */
export function convertPrompt(prompt: LanguageModelV4Prompt, resumed: boolean) {
  const system = prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  for (const message of prompt) {
    if (
      message.role === "user" &&
      message.content.some((part) => part.type !== "text")
    )
      throw new Error(
        "OpenCode's Endo adapter currently accepts text input only",
      );
  }
  const last = prompt.at(-1);
  if (!prompt.some((message) => message.role === "user"))
    throw new Error("OpenCode requires a user message in the conversation");
  const messages = (resumed && last?.role === "user" ? [last] : prompt)
    .filter((message) => message.role !== "system")
    .map((message) => ({
      ...message,
      content:
        message.role === "assistant"
          ? message.content.filter((part) => part.type !== "reasoning")
          : message.content,
    }));
  return {
    system,
    text: `Continue this Endo conversation. Prior tool calls in the transcript already ran; do not execute them again. Respond to the latest user or continue from trailing host work.\n\n${JSON.stringify(messages)}`,
  };
}
