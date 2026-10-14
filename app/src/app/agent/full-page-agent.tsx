// Purpose: Place the reusable Agent view in the full-page route with app sidebar controls.
import { useNavigate, useOutletContext, useParams } from "react-router";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";

import { PageHeader } from "@openchart/app/app/page-header";
import { ResizableSidePanel } from "@openchart/app/components/layouts/resizable-side-panel";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { promptSuggestionsQueryOptions } from "@openchart/app/lib/proactive/proactive";
import { useSidebar } from "@openchart/app/components/ui/sidebar";
import { AgentView } from "@openchart/app/features/agent/components/agent-view/agent-view";
import { AgentPanelContent } from "@openchart/app/features/agent/components/agent-panel/agent-panel";
import { Button } from "@openchart/app/components/ui/button";
import { BranchAction } from "@openchart/app/features/agent/components/thread/transcript/branch-action";
import type { AgentPanelTarget } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { cn } from "@openchart/app/utils/cn";
import type { AppRouteContext } from "@openchart/app/app/route-context";

/** Render the URL-selected conversation in the full-page host. @example <FullPageAgent /> */
export function FullPageAgent() {
  const { sessionId: sessionID } = useParams();
  return (
    <FullPageAgentSession key={sessionID ?? "new"} sessionID={sessionID} />
  );
}

function FullPageAgentSession({
  sessionID,
}: {
  sessionID: string | undefined;
}) {
  const { agent } = useAgentContext();
  const { transport } = useOutletContext<AppRouteContext>();
  const suggestions = useQuery(promptSuggestionsQueryOptions(transport));
  const navigate = useNavigate();
  const { setOpenMobile, isMobile } = useSidebar();
  const [panel, setPanel] = useState<AgentPanelTarget>();
  const content = useRef<HTMLDivElement>(null);
  const wasPanelOpen = useRef(false);
  const panelOpen = panel !== undefined;

  useEffect(() => {
    const returning = wasPanelOpen.current && !panelOpen;
    wasPanelOpen.current = panelOpen;
    if (returning)
      content.current
        ?.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')
        ?.focus();
  }, [panelOpen]);

  const submit: ComponentProps<typeof AgentView>["onSubmit"] = async (
    targetSessionID,
    draft,
    model,
    workspaceId,
  ) => {
    let targetID = targetSessionID;
    if (targetID === undefined) {
      const session = await agent.createSession.mutateAsync({});
      targetID = session.id;
      selectSession(targetID);
    }
    await agent.submitPrompt.mutateAsync({
      sessionID: targetID,
      draft,
      model,
      workspaceId,
      // A failed handoff may carry context from a surface that has since closed.
      viewContext:
        agent.submitPrompt.isError &&
        agent.submitPrompt.variables?.sessionID === targetID
          ? agent.submitPrompt.variables.viewContext
          : undefined,
    });
  };

  function selectSession(id: string) {
    void navigate(`/app/sessions/${encodeURIComponent(id)}`);
    setOpenMobile(false);
  }

  async function fork(messageID: string) {
    if (!sessionID) return;
    const session = await agent.forkSession.mutateAsync({
      sessionID,
      messageID,
    });
    selectSession(session.id);
  }

  return (
    <div className="relative flex h-dvh min-h-0 min-w-0 flex-1">
      <div
        ref={content}
        aria-hidden={(panelOpen && isMobile) || undefined}
        {...{ inert: panelOpen && isMobile ? "" : undefined }}
        className={cn(
          "flex min-h-0 min-w-0 flex-1",
          panelOpen && isMobile && "pointer-events-none opacity-0",
        )}
      >
        <AgentView
          visible={!(panelOpen && isMobile)}
          transport={transport}
          sessionID={sessionID}
          onSubmit={submit}
          header={<PageHeader />}
          onOpenPanel={setPanel}
          pendingDigIn={panel?.kind === "dig-in" ? panel : undefined}
          suggestions={suggestions.data}
          messageActions={
            <BranchAction pending={agent.forkSession.isPending} onFork={fork} />
          }
        />
      </div>
      {panelOpen ? renderPanel() : null}
    </div>
  );

  function renderPanel() {
    if (!panel) return null;
    return (
      <ResizableSidePanel
        id="agent-conversation-panel"
        label="Conversation panel"
        isMobile={isMobile}
        className="z-10 md:max-w-[50%]"
      >
        <AgentPanelContent
          transport={transport}
          target={panel}
          onBack={() => setPanel(undefined)}
          header={
            <>
              <span className="min-w-0 flex-1 truncate text-sm">
                {panel.kind === "dig-in" ? "Dig in" : panel.title}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-md"
                aria-label="Close panel"
                onClick={() => setPanel(undefined)}
              >
                <XIcon className="size-4" />
              </Button>
            </>
          }
        />
      </ResizableSidePanel>
    );
  }
}
