// Purpose: Compose the application-wide left navigation from independent sections.
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarRail,
  SidebarTrigger,
} from "@openchart/app/components/ui/sidebar";

import { NavChats, type NavChatsProps } from "./nav-chats";
import { NavMain } from "./nav-main";

/** Keep application navigation outside the routed page. @example <LeftSidebar chats={chats} onCreateChat={newChat} /> */
export function LeftSidebar({
  chats,
  onCreateChat,
}: {
  chats: NavChatsProps;
  onCreateChat: () => void;
}) {
  return (
    <Sidebar variant="floating" collapsible="offcanvas">
      <SidebarHeader className="px-1">
        <div className="flex h-9 items-center justify-between px-2">
          <span className="font-studio font-medium">Reagent</span>
          <SidebarTrigger className="text-muted-foreground" />
        </div>
        <NavMain onCreate={onCreateChat} />
      </SidebarHeader>
      <SidebarContent className="jan-sidebar-scroll">
        <NavChats {...chats} onCreate={onCreateChat} />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
