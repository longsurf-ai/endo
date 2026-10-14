// assistant-ui owns editing and sending.
import {
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import { directiveFormatter } from "@openchart/app/lib/prompt-converter/directive-formatter";

import { QuoteBlock } from "@openchart/app/features/agent/components/quote/quote";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { WorkspaceFileMentions } from "@openchart/app/features/agent/components/composer/workspace-file-mentions";
import {
  ComposerDirectiveChip,
  SlashCommands,
} from "@openchart/app/features/agent/components/composer/slash-commands";

/** EditMessage view bound to the current message composer, retaining quotes. @example <UserEditComposer /> */
export function UserEditComposer() {
  const view = useAgentView();
  const disabled = useAuiState(
    (s) => s.thread.isDisabled || s.thread.isRunning,
  );
  const quote = useAuiState((s) =>
    s.message.content.find(
      (part) => part.type === "data" && part.name === "quote",
    ),
  );
  return (
    <MessagePrimitive.Root className="mx-auto my-8 flex w-full max-w-3xl justify-end first:mt-0">
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
        <ComposerPrimitive.Root
          data-slot="edit-message"
          className="relative flex w-full max-w-sm flex-col gap-3 rounded-[20px] border border-border/60 bg-background p-3.5 dark:bg-popover"
        >
          {quote?.type === "data" && typeof quote.data === "string" ? (
            <QuoteBlock text={quote.data} />
          ) : null}
          <SlashCommands />
          <LexicalComposerInput
            formatter={directiveFormatter}
            directiveChip={ComposerDirectiveChip}
            aria-label="Edit message"
            dir="auto"
            className="min-h-16 rounded-xl bg-foreground/[0.04] px-3 py-2.5 text-[13.5px] leading-relaxed text-foreground/90 focus-within:ring-1 focus-within:ring-foreground/20 dark:bg-foreground/[0.06]"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- Editing explicitly moves focus to the selected message.
            autoFocus
          />
          {view?.workspaceId ? (
            <WorkspaceFileMentions
              key={view.workspaceId}
              transport={view.transport}
              workspaceId={view.workspaceId}
              // Keep candidates inside the editor so the transcript cannot clip them.
              className="static mb-0"
            />
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <ComposerPrimitive.Cancel className="h-8 rounded-full px-3.5 text-xs font-medium text-foreground/[0.55] outline-none transition-[background-color,color,transform] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 focus-visible:ring-1 focus-visible:ring-foreground/20 active:scale-[0.96] motion-reduce:transition-none">
              Cancel
            </ComposerPrimitive.Cancel>
            <ComposerPrimitive.Send
              disabled={disabled}
              className="flex h-8 items-center rounded-full bg-foreground px-3.5 text-xs font-medium text-background outline-none transition-[opacity,transform] duration-150 [transition-timing-function:cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.96] disabled:pointer-events-none disabled:opacity-30 motion-reduce:transition-none"
            >
              Send
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </MessagePrimitive.Root>
  );
}
