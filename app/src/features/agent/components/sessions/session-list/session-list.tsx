// Purpose: Render conversation rows using the shared sidebar menu composition.
import { Archive, MoreHorizontal, Pencil } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@openchart/app/components/ui/dropdown";
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@openchart/app/components/ui/sidebar";
import { SessionIndicator } from "./session-indicator";
import { LoadMore } from "@openchart/app/components/ui/load-more/load-more";
import type { ListedSession } from "@openchart/app/lib/agent/client";
import type { Agent } from "@openchart/app/lib/agent/use-agent";

/** Directory metadata and actions supplied by the application layout. */
export type SessionListProps = {
  query: Agent["sessions"];
  archive: Agent["archiveSession"];
  active?: string;
  onSelect: (id: string) => void;
  onRename: (session: ListedSession) => void;
  isMobile: boolean;
};

/** Render the Query-owned directory and retry controls with host-supplied navigation. @example <SessionList {...directory} /> */
export function SessionList({
  query,
  archive,
  active,
  onSelect,
  onRename,
  isMobile,
}: SessionListProps) {
  return (
    <>
      {query.isPending ? (
        <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
          Loading chats…
        </p>
      ) : null}
      {query.isError && !query.isFetchNextPageError ? (
        <div className="px-2 py-3 text-xs">
          <button
            className="underline"
            onClick={() => {
              void query.refetch();
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {query.isSuccess && !query.data.length ? (
        <p className="px-2 py-3 text-xs text-muted-foreground">
          Your conversations will appear here.
        </p>
      ) : null}
      <SidebarMenu>
        {query.data?.map((session) => (
          <SidebarMenuItem key={session.id}>
            <SidebarMenuButton
              isActive={session.id === active}
              onClick={() => onSelect(session.id)}
              aria-current={session.id === active ? "page" : undefined}
              title={session.title || "New chat"}
            >
              <SessionIndicator
                isActive={session.isActive}
                isUnread={session.isUnread}
              />
              <span
                className={
                  session.id === active ? "truncate font-medium" : "truncate"
                }
              >
                {session.title || "New chat"}
              </span>
            </SidebarMenuButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction
                  showOnHover
                  aria-label={`Options for ${session.title || "New chat"}`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-48"
                side={isMobile ? "bottom" : "right"}
                align={isMobile ? "end" : "start"}
              >
                <DropdownMenuItem onSelect={() => onRename(session)}>
                  <Pencil className="size-4" aria-hidden="true" /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={archive.isPending}
                  onSelect={() => archive.mutate({ sessionID: session.id })}
                >
                  <Archive className="size-4" aria-hidden="true" /> Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
      <LoadMore
        hasMore={query.hasNextPage && !query.isRefetchError}
        loading={query.isFetching}
        error={query.isFetchNextPageError}
        onLoadMore={() => {
          void query.fetchNextPage();
        }}
        label="Show more chats"
      />
    </>
  );
}
