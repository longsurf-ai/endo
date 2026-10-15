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
import { UpdateButton, useUpdateReady } from "./update-button";
import { EndoMark } from "@openchart/app/components/ui/brand/endo-mark";

/** Keep application navigation outside the routed page. @example <LeftSidebar chats={chats} onCreateChat={newChat} /> */
export function LeftSidebar({
  chats,
  onCreateChat,
}: {
  chats: NavChatsProps;
  onCreateChat: () => void;
}) {
  const release = useUpdateReady();
  return (
    <Sidebar variant="floating" collapsible="offcanvas">
      <SidebarHeader className="px-1">
        <div className="flex h-9 items-center justify-between px-2">
          <div className="flex items-center gap-2">
            <EndoMark className="size-8 rounded-md" />
            <span className="font-studio font-medium">Endo</span>
          </div>
          <div className="flex items-center gap-1">
            {release && <UpdateButton release={release} />}
            <SidebarTrigger className="text-muted-foreground" />
          </div>
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
