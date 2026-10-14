// Purpose: Render the Session directory with assistant-ui's thread picker primitives.
// ThreadList / ThreadListItem own iteration, active state and switch actions;
// the existing Radix menu owns dropdown focus, keyboard interaction and closing.
import {
  AssistantRuntimeProvider,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useExternalStoreRuntime,
  type ThreadMessage,
} from "@assistant-ui/react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";

import { Button } from "@openchart/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import { useAgentContext } from "@openchart/app/lib/agent/provider";

const emptyMessages: readonly ThreadMessage[] = [];

/**
 * Show the shared Session directory using assistant-ui, with selection owned by
 * the host. This directory-only runtime never observes or sends messages; each
 * AgentView retains its own conversation runtime. Query owns loading and retry.
 * @example <SessionPicker sessionID={sessionID} onSelect={setSessionID} />
 */
export function SessionPicker({
  sessionID,
  onSelect,
  disabled,
}: {
  sessionID: string | undefined;
  onSelect: (sessionID: string | undefined) => void;
  disabled?: boolean;
}) {
  const { agent } = useAgentContext();
  const { sessions } = agent;
  const runtime = useExternalStoreRuntime({
    messages: emptyMessages,
    isDisabled: true,
    onNew: async () => {
      throw new Error("Send messages through AgentView.");
    },
    adapters: {
      threadList: {
        threadId: sessionID,
        isLoading: sessions.isPending,
        threads: (sessions.data ?? []).map(({ id, title }) => ({
          id,
          title,
          status: "regular" as const,
        })),
        onSwitchToThread: onSelect,
        onSwitchToNewThread: () => onSelect(undefined),
      },
    },
  });
  const title = sessions.data?.find(
    (session) => session.id === sessionID,
  )?.title;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="min-w-0 flex-1 justify-between gap-2 rounded-md px-2"
            aria-label="Select conversation"
            disabled={disabled}
          >
            <span className="truncate">{title || "New chat"}</span>
            <ChevronDownIcon className="size-4 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <ThreadListPrimitive.Root>
            <ThreadListPrimitive.New asChild>
              <DropdownMenuItem>
                <PlusIcon className="size-4" /> New chat
              </DropdownMenuItem>
            </ThreadListPrimitive.New>
            {sessions.isPending ? (
              <p
                role="status"
                className="px-2 py-3 text-sm text-muted-foreground"
              >
                Loading conversations…
              </p>
            ) : null}
            {sessions.isError ? (
              <DropdownMenuItem onSelect={() => void sessions.refetch()}>
                Couldn’t load conversations. Try again
              </DropdownMenuItem>
            ) : null}
            <ThreadListPrimitive.Items
              components={{ ThreadListItem: SessionItem }}
            />
          </ThreadListPrimitive.Root>
        </DropdownMenuContent>
      </DropdownMenu>
    </AssistantRuntimeProvider>
  );
}

function SessionItem() {
  return (
    <ThreadListItemPrimitive.Root className="rounded-sm data-[active]:bg-accent">
      <ThreadListItemPrimitive.Trigger asChild>
        <DropdownMenuItem>
          <span className="truncate">
            <ThreadListItemPrimitive.Title fallback="New chat" />
          </span>
        </DropdownMenuItem>
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  );
}
