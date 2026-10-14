import { toast } from "sonner";
// Purpose: Use the official ChatGPT composer with OpenChart's model-control slot.
import {
  AuiIf,
  ComposerPrimitive,
  useAui,
  useAuiEvent,
} from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import { directiveFormatter } from "@openchart/app/lib/prompt-converter/directive-formatter";
import { ArrowUpIcon } from "lucide-react";
import { type ReactNode } from "react";
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@openchart/app/features/agent/components/attachment/attachment.aui";
import { ComposerQuotePreview } from "@openchart/app/features/agent/components/quote/quote";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { WorkspaceFileMentions } from "./workspace-file-mentions";
import { ComposerDirectiveChip, SlashCommands } from "./slash-commands";
import { CommandArgumentHint } from "./command-argument-hint";

/** Render the shared composer. Edit mode embeds in a host form: Enter inserts a newline and the host saves the native draft. @example <AgentComposer mode="edit" /> */
export function AgentComposer({
  leading,
  context,
  mode = "send",
}: {
  leading?: ReactNode;
  context?: ReactNode;
  mode?: "send" | "edit";
}) {
  const Container = mode === "edit" ? "div" : "form";
  const view = useAgentView();
  const aui = useAui();
  useAuiEvent("composer.attachmentAddError", ({ message }) =>
    toast.error("Couldn’t attach file", { description: message }),
  );
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <ComposerPrimitive.Root asChild>
          <Container className="group/composer relative flex w-full flex-col rounded-[28px] border border-[#e5e5e5] bg-white px-2 py-2 focus-within:border-[#d0d0d0] data-[dragging=true]:bg-muted dark:border-transparent dark:bg-[#212121] dark:focus-within:border-transparent">
            <ComposerAttachments />
            <ComposerQuotePreview />
            {context}
            <SlashCommands />
            <LexicalComposerInput
              // Lexical has no file-paste plugin. Forward files to the same runtime
              // as ComposerPrimitive.Input; capture before Lexical consumes paste.
              onPasteCapture={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (aui.thread.getState().isDisabled || !files.length) return;
                event.preventDefault();
                event.stopPropagation();
                for (const file of files) {
                  // assistant-ui reports rejection through attachmentAddError.
                  void aui.composer.addAttachment(file).catch(() => {});
                }
              }}
              formatter={directiveFormatter}
              directiveChip={ComposerDirectiveChip}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- The composer is the primary input when entering a conversation.
              autoFocus={mode === "send"}
              submitMode={mode === "edit" ? "none" : "enter"}
              aria-label={mode === "edit" ? "Prompt" : "Message"}
              placeholder="Ask anything, or @ a workspace file"
              dir="auto"
              className="min-h-9 w-full bg-transparent py-1.5 pl-1 pr-2 text-base text-[#0d0d0d] dark:text-[#ececec]"
            />
            <CommandArgumentHint />
            {view?.workspaceId ? (
              <WorkspaceFileMentions
                key={view.workspaceId}
                transport={view.transport}
                workspaceId={view.workspaceId}
              />
            ) : null}
            <div className="flex items-center gap-1 pt-1">
              <ComposerAddAttachment />
              {leading ? (
                <div className="min-w-0 flex-1 px-1">{leading}</div>
              ) : null}
              {mode === "send" ? (
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  <AuiIf condition={(s) => s.thread.isRunning}>
                    <ComposerPrimitive.Cancel
                      aria-label="Stop generating"
                      className="flex size-9 items-center justify-center rounded-full bg-[#0d0d0d] text-white dark:bg-white dark:text-black"
                    >
                      <div className="size-2.5 rounded-[2px] bg-current" />
                    </ComposerPrimitive.Cancel>
                  </AuiIf>
                  <AuiIf condition={(s) => !s.thread.isRunning}>
                    <ComposerPrimitive.Send
                      aria-label="Send message"
                      className="flex size-9 items-center justify-center rounded-full bg-[#0d0d0d] text-white transition-opacity disabled:opacity-30 dark:bg-white dark:text-black"
                    >
                      <ArrowUpIcon className="size-6" />
                    </ComposerPrimitive.Send>
                  </AuiIf>
                </div>
              ) : null}
            </div>
          </Container>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}
