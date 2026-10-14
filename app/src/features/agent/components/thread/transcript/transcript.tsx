// Purpose: Reuse ChatGPT message presentation with native Agent parts and final-reply actions.
import {
  ActionBarPrimitive,
  AuiIf,
  ThreadPrimitive,
  MessagePrimitive,
  useAuiState,
  type DataMessagePartProps,
  type ThreadMessage,
} from "@assistant-ui/react";
import {
  createContext,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { CheckIcon, CopyIcon, PencilIcon, SearchIcon } from "lucide-react";
import { AgentParts } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/agent-parts";
import { TooltipIconButton } from "@openchart/app/components/ui/tooltip-icon-button/tooltip-icon-button";
import { QuoteBlock } from "@openchart/app/features/agent/components/quote/quote";
import { UserEditComposer } from "./edit-message/edit-message";
import { WorkingTrace } from "./working-trace";
import { DirectiveText } from "./directive-text/directive-text.aui";
import { UserWorkflow } from "./user-workflow";
import { CompactionMarker } from "./compaction-marker";
import { UserMessageAttachments } from "@openchart/app/features/agent/components/attachment/attachment.aui";

function UserQuote({ data }: DataMessagePartProps<string>) {
  return <QuoteBlock text={data} />;
}
function UserDigIn({ data }: DataMessagePartProps<string>) {
  return <QuoteBlock text={data} icon={SearchIcon} />;
}

function MessageActions({ children }: { children?: ReactNode }) {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className="flex items-center gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton
          tooltip="Copy message"
          side="top"
          className="flex size-8 items-center justify-center rounded-lg text-[#5d5d5d] transition-colors hover:bg-black/[0.07] hover:text-[#5d5d5d] dark:text-[#cdcdcd] dark:hover:bg-white/15 dark:hover:text-[#cdcdcd]"
        >
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="size-5" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="size-5" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      {children}
    </ActionBarPrimitive.Root>
  );
}
function UserMessageActions() {
  const disabled = useAuiState(
    (s) => s.thread.isDisabled || s.thread.isRunning,
  );
  return (
    <div className="opacity-0 focus-within:opacity-100 group-hover/user-message:opacity-100 [@media(hover:none)]:opacity-100">
      <MessageActions>
        <AuiIf
          condition={(s) =>
            s.thread.capabilities.edit &&
            !s.message.attachments?.length &&
            s.message.content.every(
              (part) =>
                part.type === "text" ||
                (part.type === "data" && part.name === "quote"),
            )
          }
        >
          <ActionBarPrimitive.Edit asChild disabled={disabled}>
            <TooltipIconButton
              tooltip="Edit message"
              side="top"
              className="flex size-8 items-center justify-center rounded-lg text-[#5d5d5d] hover:bg-black/[0.07] dark:text-[#cdcdcd] dark:hover:bg-white/15"
            >
              <PencilIcon className="size-5" />
            </TooltipIconButton>
          </ActionBarPrimitive.Edit>
        </AuiIf>
      </MessageActions>
    </div>
  );
}

function UserMessage() {
  const id = useAuiState((s) => s.message.id);
  const compaction = useAuiState((s) => s.message.metadata.custom.compaction);
  const editing = useAuiState((s) => s.message.composer.isEditing);
  const visible = useAuiState(
    (s) =>
      !!s.message.attachments?.length ||
      s.message.content.some(
        (part) => part.type !== "text" || part.text.length > 0,
      ),
  );
  if (
    compaction === "running" ||
    compaction === "complete" ||
    compaction === "incomplete"
  )
    return <CompactionMarker status={compaction} />;
  if (editing) return <UserEditComposer />;
  if (!visible) return null;
  return (
    <MessagePrimitive.Root
      data-transcript-message={id}
      data-aui-quote-selectable="false"
      className="group/user-message relative mx-auto my-8 flex w-full max-w-3xl flex-col items-end gap-1 first:mt-0"
    >
      <UserMessageAttachments />
      <AuiIf condition={(s) => s.message.content.length > 0}>
        <div
          className="max-w-[70%] whitespace-pre-wrap break-words rounded-[22px] bg-[#0d0d0d] px-4 py-2.5 leading-6 text-foreground [--background:color-mix(in_srgb,var(--foreground)_10%,transparent)] [--border:color-mix(in_srgb,var(--foreground)_20%,transparent)] [--foreground:#fff] [--popover:var(--background)] dark:bg-[#ececec] dark:[--foreground:#0d0d0d] [&_[data-slot=directive-text-chip]]:border-[color-mix(in_srgb,currentColor_20%,transparent)] [&_[data-slot=directive-text-chip]]:bg-[color-mix(in_srgb,currentColor_10%,transparent)] [&_[data-slot=directive-text-chip]]:text-inherit"
          dir="auto"
        >
          <MessagePrimitive.Parts
            components={{
              Text: DirectiveText,
              data: {
                by_name: {
                  quote: UserQuote,
                  dig_in: UserDigIn,
                  workflow: UserWorkflow,
                },
              },
            }}
          />
        </div>
      </AuiIf>
      <UserMessageActions />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({
  messageActions,
  hideActions = false,
  ...parts
}: ComponentProps<typeof AgentParts> & {
  messageActions?: ReactNode;
  hideActions?: boolean;
}) {
  const id = useAuiState((s) => s.message.id);
  return (
    <MessagePrimitive.Root
      data-transcript-message={id}
      data-aui-quote-selectable=""
      className="relative mx-auto flex w-full max-w-3xl flex-col [&>.aui-md]:my-3"
    >
      <AgentParts {...parts} />
      <AuiIf
        condition={(s) =>
          !hideActions && s.message.metadata.custom.showActions === true
        }
      >
        <div className="-ml-2 flex items-center pt-1">
          <MessageActions>{messageActions}</MessageActions>
        </div>
      </AuiIf>
    </MessagePrimitive.Root>
  );
}

function getAssistantTurnState(
  messages: readonly ThreadMessage[],
  start: number,
  end: number,
) {
  let started = false;
  let unfinished = false;
  let answerMessage: number | undefined;
  let answerPart: number | undefined;
  for (let index = start; index < end; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const finalReplyStartIndex = message.metadata.custom.finalReplyStartIndex;
    if (typeof finalReplyStartIndex === "number") {
      answerMessage = index;
      answerPart = finalReplyStartIndex;
    }
    unfinished ||=
      message.status.type === "incomplete" ||
      message.status.type === "requires-action";
    message.content.forEach((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        started ||= part.text.trim().length > 0;
      } else if (part.type === "tool-call") {
        started = true;
      }
      if (part.type === "tool-call")
        unfinished ||= part.result === undefined || part.isError === true;
    });
  }
  const createdAt = messages[start]!.metadata.custom.sourceCreatedAt;
  const completedAt = messages[end - 1]!.metadata.custom.sourceCompletedAt;
  return {
    started,
    unfinished,
    answerMessage,
    hasWork:
      answerMessage === undefined ||
      answerPart !== 0 ||
      messages
        .slice(start, end)
        .some(
          (message, index) =>
            start + index !== answerMessage && message.content.length > 0,
        ),
    createdAt: typeof createdAt === "number" ? createdAt : undefined,
    completedAt: typeof completedAt === "number" ? completedAt : undefined,
  };
}

// These contexts carry host slots and turn lifecycle, never streaming content.
const MessageActionsContext = createContext<ReactNode>(undefined);
const TurnRunningContext = createContext(false);

function WorkMessage() {
  const running = useContext(TurnRunningContext);
  const limit = useAuiState(
    (s) => s.message.metadata.custom.finalReplyStartIndex,
  );
  if (limit === 0) return null;
  return (
    <AssistantMessage
      endIndex={typeof limit === "number" ? limit : undefined}
      showReasoning={!running}
      hideActions
    />
  );
}

function FinalMessage() {
  const messageActions = useContext(MessageActionsContext);
  const start = useAuiState(
    (s) => s.message.metadata.custom.finalReplyStartIndex,
  );
  return (
    <AssistantMessage
      startIndex={typeof start === "number" ? start : undefined}
      messageActions={messageActions}
    />
  );
}

const WORK_COMPONENTS = { Message: WorkMessage };
const FINAL_COMPONENTS = { Message: FinalMessage };

function AssistantTurn() {
  const turn = useAuiState(
    useShallow((s) => {
      const messages = s.thread.messages;
      const start = s.message.index;
      // The first assistant owns the disclosure; subsequent messages render within it.
      if (messages[start - 1]?.role === "assistant") return null;
      let end = start + 1;
      while (messages[end]?.role === "assistant") end++;
      // Compaction owns its indicator, including the runtime's empty placeholder.
      if (
        (messages[start - 1]?.metadata.custom.compaction ||
          messages.some(
            (message) => message.metadata.custom.compaction === "running",
          )) &&
        messages
          .slice(start, end)
          .every((message) => message.content.length === 0)
      )
        return null;
      return {
        start,
        end,
        running: s.thread.isRunning && end === messages.length,
        ...getAssistantTurnState(messages, start, end),
      };
    }),
  );
  if (!turn) return null;
  return (
    <TurnRunningContext.Provider value={turn.running}>
      {turn.hasWork && (
        <WorkingTrace
          started={turn.started}
          running={turn.running}
          complete={turn.answerMessage !== undefined && !turn.unfinished}
          createdAt={turn.createdAt}
          completedAt={turn.completedAt}
        >
          {Array.from({ length: turn.end - turn.start }, (_, offset) => (
            <ThreadPrimitive.MessageByIndex
              key={turn.start + offset}
              index={turn.start + offset}
              components={WORK_COMPONENTS}
            />
          ))}
        </WorkingTrace>
      )}
      {turn.answerMessage !== undefined && (
        <ThreadPrimitive.MessageByIndex
          index={turn.answerMessage}
          components={FINAL_COMPONENTS}
        />
      )}
    </TurnRunningContext.Provider>
  );
}

const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage: AssistantTurn };

/** Render native messages using upstream list/message subscription boundaries; AgentLayout owns the viewport. @example <AgentTranscript messageActions={<BranchAction onFork={fork} pending={false} />} /> */
export function AgentTranscript({
  messageActions,
}: {
  messageActions?: ReactNode;
}) {
  return (
    <MessageActionsContext.Provider value={messageActions}>
      <AuiIf condition={(s) => s.thread.isLoading}>
        <p
          className="mx-auto w-full max-w-3xl text-sm text-muted-foreground"
          role="status"
        >
          Loading conversation…
        </p>
      </AuiIf>
      <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
    </MessageActionsContext.Provider>
  );
}
