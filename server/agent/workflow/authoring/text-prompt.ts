// Purpose: Builds a single-text Agent prompt with explicit model and agent selection.

import type { AgentPromptInput } from "@openchart/server/agent/contracts/agent-prompt-input";

/**
 * Builds a prompt without validation, execution, or resource allocation.
 * The authoring agent() call owns boundary validation and execution.
 * @example
 * const input = textPrompt('Research AAPL.', parentPrompt.model, parentPrompt.agent);
 */
export function textPrompt(
  text: string,
  model: AgentPromptInput["model"],
  agent: string,
): AgentPromptInput {
  return { agent, model, parts: [{ type: "text", text }] };
}
