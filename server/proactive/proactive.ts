// Purpose: Offer the user next steps before they ask.
import { starterPrompts } from "./starter-prompts";

/**
 * One prompt the app offers to send for the user. `title` is displayed as
 * written, including any leading emoji; `prompt` is sent when it is selected.
 */
export type PromptSuggestion = {
  readonly title: string;
  readonly prompt: string;
};

/**
 * Every prompt to suggest for a new chat, best first; the app decides how many
 * to show at once. Today this is the curated {@link starterPrompts} list; a
 * personalized ranking can replace it without changing the transport or the app.
 * @example const suggestions = listPromptSuggestions();
 */
export function listPromptSuggestions(): readonly PromptSuggestion[] {
  return starterPrompts;
}
