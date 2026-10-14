// Purpose: Share application sidebar and Copilot controls across routed page headers.
import type { ReactNode } from "react";

import { CopilotTrigger } from "@openchart/app/app/agent/copilot-controls";
import {
  SidebarTrigger,
  useSidebar,
} from "@openchart/app/components/ui/sidebar";

/** The 60px app header; optional center content stays centered across the full header independently of the title and actions. Actions precede Copilot. @example <PageHeader center={viewTabs} actions={createButton}>Schedule</PageHeader> */
export function PageHeader({
  children,
  center,
  actions,
}: {
  children?: ReactNode;
  center?: ReactNode;
  actions?: ReactNode;
}) {
  const { open, isMobile } = useSidebar();
  return (
    <header className="jan-chat-header px-4 [container:page-header/inline-size]">
      <div
        className={
          center ? "page-header-centered" : "flex w-full items-center gap-1"
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {!open || isMobile ? <SidebarTrigger /> : null}
          <div className="min-w-0 flex-1">{children}</div>
        </div>
        {center ? <div>{center}</div> : null}
        <div className="flex items-center justify-end gap-1">
          {actions}
          <CopilotTrigger />
        </div>
      </div>
    </header>
  );
}
