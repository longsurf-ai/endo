// Purpose: Render the existing branch action while the host owns its command and navigation.
import { useAuiState } from "@assistant-ui/react";
import { SplitIcon } from "lucide-react";

import { TooltipIconButton } from "@openchart/app/components/ui/tooltip-icon-button/tooltip-icon-button";

/** Branch from a canonical Message ID inside the transcript's final-reply action slot. @example <BranchAction onFork={forkSession} pending={pending} /> */
export function BranchAction({
  onFork,
  pending,
}: {
  onFork: (messageID: string) => Promise<void>;
  pending: boolean;
}) {
  const messageID = useAuiState(
    (s) => s.message.metadata.custom.sourceMessageId,
  );
  if (typeof messageID !== "string") return null;
  return (
    <TooltipIconButton
      tooltip="Branch in new chat"
      side="top"
      disabled={pending}
      aria-busy={pending}
      className="flex size-8 items-center justify-center rounded-lg text-[#5d5d5d] transition-colors hover:bg-black/[0.07] hover:text-[#5d5d5d] dark:text-[#cdcdcd] dark:hover:bg-white/15 dark:hover:text-[#cdcdcd]"
      onClick={() => {
        void onFork(messageID).catch(() => {});
      }}
    >
      <SplitIcon className="size-5 rotate-90" />
    </TooltipIconButton>
  );
}
