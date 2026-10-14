// Purpose: List suggested prompts beneath an empty chat's composer.
import { ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@openchart/app/components/ui/button";
import { TooltipIconButton } from "@openchart/app/components/ui/tooltip-icon-button/tooltip-icon-button";
import type { PromptSuggestion } from "@openchart/app/lib/proactive/proactive";
import { cn } from "@openchart/app/utils/cn";

const VISIBLE_COUNT = 4;

/**
 * Show four suggestions at a time, in the backend's order; Refresh, revealed
 * on hover or keyboard focus, rotates to the next four and wraps around. Each
 * title is shown exactly as written, spaces included, and selecting it sends
 * its prompt through the thread's normal submission. Rows hide while the composer has a draft, so a click never
 * replaces typed input, and keep their space so the layout does not move.
 * @example <PromptSuggestions suggestions={suggestions} />
 */
export function PromptSuggestions({
  suggestions,
}: {
  suggestions: readonly PromptSuggestion[];
}) {
  const drafting = useAuiState((s) => !s.composer.isEmpty);
  const [start, setStart] = useState(0);
  const count = Math.min(VISIBLE_COUNT, suggestions.length);
  const visible = [...suggestions, ...suggestions].slice(start, start + count);
  return (
    <div
      role="group"
      aria-label="Suggested prompts"
      className={cn("group/suggestions flex flex-col", drafting && "invisible")}
    >
      {visible.map(({ title, prompt }) => (
        <Button
          key={title}
          asChild
          variant="ghost"
          className="h-auto justify-start px-2.5 py-2 text-base font-normal text-muted-foreground hover:text-foreground"
        >
          <ThreadPrimitive.Suggestion prompt={prompt} send>
            <span className="whitespace-pre-wrap break-words text-left">
              {title}
            </span>
          </ThreadPrimitive.Suggestion>
        </Button>
      ))}
      {suggestions.length > VISIBLE_COUNT ? (
        <TooltipIconButton
          type="button"
          tooltip="Refresh suggestions"
          className="mt-1 size-8 self-start text-muted-foreground opacity-0 transition-opacity group-focus-within/suggestions:opacity-100 group-hover/suggestions:opacity-100"
          onClick={() => setStart((start + VISIBLE_COUNT) % suggestions.length)}
        >
          <RefreshCwIcon />
        </TooltipIconButton>
      ) : null}
    </div>
  );
}
