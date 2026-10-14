// Purpose: Place the Agent-owned Session directory in application navigation.
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { SidebarGroup, useSidebar } from "@openchart/app/components/ui/sidebar";
import {
  SessionList,
  type SessionListProps,
} from "@openchart/app/features/agent/components/sessions/session-list/session-list";
import { SectionHeader } from "./section-header";

/** URL selection and rename-dialog controls supplied by Layout. */
export type NavChatsProps = Pick<
  SessionListProps,
  "active" | "onSelect" | "onRename"
>;

/** Compose the feature-owned directory with the app's sidebar position. @example <NavChats active={sessionID} onSelect={selectSession} onRename={openRename} /> */
export function NavChats({
  onCreate,
  ...props
}: NavChatsProps & { onCreate: () => void }) {
  const { agent } = useAgentContext();
  const { isMobile } = useSidebar();
  return (
    <SidebarGroup role="group" aria-label="Chats">
      <SectionHeader
        section="chats"
        label="Chats"
        createLabel="New chat"
        onCreate={onCreate}
      />
      <SessionList
        query={agent.sessions}
        archive={agent.archiveSession}
        {...props}
        isMobile={isMobile}
      />
    </SidebarGroup>
  );
}
