// Purpose: Mount the shared file workspace with only application navigation controls.
import { useOutletContext, useSearchParams } from "react-router";
import type { AppRouteContext } from "@openchart/app/app/route-context";
import { CopilotTrigger } from "@openchart/app/app/agent/copilot-controls";
import { Button } from "@openchart/app/components/ui/button";
import { useSidebar } from "@openchart/app/components/ui/sidebar";
import { PanelLeft } from "lucide-react";
import { WorkspaceView } from "@openchart/app/features/workspace/components/workspace-view";

/** Mount the file explorer in a full-page route. @example <WorkspacePage /> */
export function WorkspacePage() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  const { transport } = useOutletContext<AppRouteContext>();
  const [search] = useSearchParams();
  const workspaceId = search.get("workspaceId");
  const path = search.get("path");
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        <WorkspaceView
          transport={transport}
          title="Workspace"
          file={workspaceId && path ? { workspaceId, path } : undefined}
          navigation={
            !open || isMobile ? (
              <div data-workspace-navigation>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Toggle navigation"
                  onClick={toggleSidebar}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <PanelLeft className="size-4" />
                </Button>
              </div>
            ) : null
          }
          actions={<CopilotTrigger />}
        />
      </div>
    </div>
  );
}
