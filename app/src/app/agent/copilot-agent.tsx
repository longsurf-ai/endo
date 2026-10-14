// Purpose: Host the persistent application Copilot beside routed pages.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useAui } from "@assistant-ui/react";
import { XIcon } from "lucide-react";

import { Button } from "@openchart/app/components/ui/button";
import { ResizableSidePanel } from "@openchart/app/components/layouts/resizable-side-panel";
import { useSidebar } from "@openchart/app/components/ui/sidebar";
import type { ModelSelection } from "@openchart/app/lib/agent/client";
import { AgentPanel } from "@openchart/app/features/agent/components/agent-panel/agent-panel";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { SessionPicker } from "@openchart/app/features/agent/components/sessions/session-picker/session-picker";
import { BranchAction } from "@openchart/app/features/agent/components/thread/transcript/branch-action";
import type { ComposerDraft } from "@openchart/app/lib/prompt-converter/converter";
import type { AppTransport } from "@openchart/app/lib/transport/transport";
import type { CopilotPrefill } from "./copilot-controls";

/**
 * Render Layout's selected Session and the Copilot header. Closing hides the mounted
 * panel, preserving its draft and observation without cancelling execution.
 * AppLayout controls visibility, including hiding it on full-page Agent routes.
 * When the page is hidden on mobile, Layout places shared notices here.
 * Desktop width stays local to this mount and is bounded by the viewport.
 * Mounting or choosing New chat creates nothing; the first send creates and
 * selects a Session before submitting. Failures retain assistant-ui's draft.
 * @example <CopilotAgent transport={transport} sessionID={sessionID} onSelectSession={setSessionID} open={open} onClose={() => setOpen(false)} />
 */
export function CopilotAgent({
  transport,
  sessionID,
  onSelectSession,
  open,
  notices,
  onClose,
  prefill,
  onPrefillApplied,
}: {
  transport: AppTransport;
  sessionID: string | undefined;
  onSelectSession: (sessionID: string | undefined) => void;
  open: boolean;
  notices?: ReactNode;
  onClose: () => void;
  prefill?: CopilotPrefill;
  onPrefillApplied: () => void;
}) {
  const { agent } = useAgentContext();
  const aui = useAui();
  const { isMobile } = useSidebar();
  const panelRef = useCopilotFocus(open);

  return (
    <ResizableSidePanel
      ref={panelRef}
      id="app-copilot"
      label="Copilot"
      isMobile={isMobile}
      hidden={!open}
    >
      {notices}
      <AgentPanel
        visible={open}
        transport={transport}
        sessionID={sessionID}
        revealRoot={prefill}
        onSubmit={submit}
        header={renderHeader()}
        messageActions={
          <BranchAction pending={agent.forkSession.isPending} onFork={fork} />
        }
      >
        <PrefillComposer
          request={prefill}
          panelRef={panelRef}
          onApplied={onPrefillApplied}
        />
      </AgentPanel>
    </ResizableSidePanel>
  );

  async function submit(
    targetSessionID: string | undefined,
    draft: ComposerDraft,
    model: ModelSelection,
    workspaceId?: string,
  ) {
    // Capture before Session creation or navigation can change the visible page.
    const viewContext = aui.modelContext.getModelContext().system;
    let targetID = targetSessionID;
    if (targetID === undefined) {
      const session = await agent.createSession.mutateAsync({});
      targetID = session.id;
      onSelectSession(targetID);
    }
    await agent.submitPrompt.mutateAsync({
      sessionID: targetID,
      draft,
      model,
      workspaceId,
      viewContext,
    });
  }

  async function fork(messageID: string) {
    if (!sessionID) return;
    const session = await agent.forkSession.mutateAsync({
      sessionID,
      messageID,
    });
    onSelectSession(session.id);
  }

  function renderHeader() {
    return (
      <>
        <SessionPicker
          sessionID={sessionID}
          onSelect={onSelectSession}
          disabled={
            agent.createSession.isPending || agent.forkSession.isPending
          }
        />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-md"
          aria-label="Close Copilot"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </>
    );
  }
}

function PrefillComposer({
  request,
  panelRef,
  onApplied,
}: {
  request?: CopilotPrefill;
  panelRef: RefObject<HTMLElement>;
  onApplied: () => void;
}) {
  const aui = useAui();
  const applied = useRef<CopilotPrefill>();
  useEffect(() => {
    if (!request || applied.current === request) return;
    applied.current = request;
    const composer = aui.thread().composer();
    const text = composer.getState().text;
    if (!text.includes(request.text))
      composer.setText(
        text.trim() ? `${text}\n\n${request.text}` : request.text,
      );
    // Focus after the opening panel and closing menu finish their own focus effects.
    queueMicrotask(() =>
      panelRef.current
        ?.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')
        ?.focus(),
    );
    onApplied();
  }, [request, aui, panelRef, onApplied]);
  return null;
}

function useCopilotFocus(open: boolean) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const returnFocus = document.activeElement;
    panelRef.current
      ?.querySelector<HTMLElement>(
        '[role="textbox"][contenteditable="true"], button:not(:disabled)',
      )
      ?.focus();
    return () => {
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
        returnFocus.focus();
      }
    };
  }, [open]);
  return panelRef;
}
