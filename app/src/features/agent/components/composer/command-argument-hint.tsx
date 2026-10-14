// Purpose: Show command usage from the catalog without owning or changing the draft.
import { useAuiState } from "@assistant-ui/react";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { readLeadingCommand } from "@openchart/app/lib/prompt-converter/converter";

/** Displays guidance for the leading command; typing arguments preserves the hint. @example <CommandArgumentHint /> */
export function CommandArgumentHint() {
  const { agent } = useAgentContext();
  const commandName = useAuiState(
    ({ composer: { text } }) => readLeadingCommand(text)?.command,
  );
  const hint = agent.commands.data?.find(
    (command) => command.name === commandName,
  )?.argumentHint;

  return hint ? (
    <p
      role="status"
      className="break-words px-1 pt-1 text-xs text-muted-foreground"
    >
      {hint}
    </p>
  ) : null;
}
