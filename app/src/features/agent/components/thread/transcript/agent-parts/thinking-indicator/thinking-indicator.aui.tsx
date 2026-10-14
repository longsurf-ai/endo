// Purpose: Project live backend reasoning into one status line without owning run state.
import { useAuiState } from "@assistant-ui/react";

import { ThinkingIndicator } from "./thinking-indicator";

/**
 * Shows the latest reasoning paragraph while it streams, or Thinking before
 * content arrives. Tool calls and replies keep their own renderers. No timer,
 * transcript copy, or generated summary is maintained here.
 * @example <AssistantThinking />
 */
export function AssistantThinking() {
  const label = useAuiState((s) => {
    if (s.message.status?.type !== "running") return undefined;
    const part = s.message.parts.at(-1);
    if (!part) return "Thinking";
    if (part.type !== "reasoning" || part.status.type !== "running")
      return undefined;

    const paragraph =
      part.text
        .trim()
        .split(/\n\s*\n/)
        .at(-1) ?? "";
    return (
      paragraph
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*/g, "")
        .replace(/\s+/g, " ")
        .trim() || "Thinking"
    );
  });

  if (label === undefined) return null;
  return (
    <ThinkingIndicator
      data-aui-quote-selectable="false"
      label={label}
      className="py-1.5"
      role="status"
    />
  );
}
