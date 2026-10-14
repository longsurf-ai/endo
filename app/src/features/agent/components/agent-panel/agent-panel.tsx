// Purpose: Own nested conversation views inside a host-supplied panel.
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@openchart/app/components/ui/button";
import { AgentView } from "@openchart/app/features/agent/components/agent-view/agent-view";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { useSessionSnapshot } from "@openchart/app/lib/agent/use-session-snapshot";
import {
  digInViewKey,
  type AgentPanelTarget,
  type DigInTarget,
} from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { QuotePreview } from "@openchart/app/features/agent/components/quote/quote";
import { cn } from "@openchart/app/utils/cn";
import type { AppTransport } from "@openchart/app/lib/transport/transport";

type AgentPanelProps = ComponentProps<typeof AgentView> & {
  onBack?: () => void;
  /** A host request reveals the root composer while retaining covered drafts. */
  revealRoot?: object;
};

/**
 * Hosts supply the root Session, header and optional return action. Each nested
 * layer keeps the covered view mounted, preserving its composer, model choice
 * and scroll position. Back removes only the top layer; changing the root Session
 * resets the panel. Hiding or returning never cancels backend execution.
 *
 * @remarks
 * CopilotAgent owns the root Session dropdown and supplies it through `header`.
 * FullPageAgent places the same panel beside its main AgentView.
 * A selection opens a local Dig In draft. DigInPanel creates its child only on
 * the first send, through the existing Agent commands. Transcript observation
 * remains shared by SessionStore.
 *
 * @example <AgentPanel transport={transport} sessionID={sessionID} onSubmit={submit} header={header} />
 */
export function AgentPanel(props: AgentPanelProps) {
  return <AgentPanelLayer key={props.sessionID ?? "new"} {...props} />;
}

function AgentPanelLayer({
  visible = true,
  header,
  onBack,
  revealRoot,
  ...view
}: AgentPanelProps) {
  const [nested, setNested] = useState<{
    target: AgentPanelTarget;
    visible: boolean;
  }>();
  const nestedVisible = nested?.visible ?? false;
  const content = useRef<HTMLDivElement>(null);
  const wasNested = useRef(false);
  useEffect(() => {
    if (revealRoot)
      setNested((current) =>
        current ? { ...current, visible: false } : current,
      );
  }, [revealRoot]);

  useEffect(() => {
    const returning = wasNested.current && !nestedVisible;
    wasNested.current = nestedVisible;
    if (returning)
      content.current
        ?.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')
        ?.focus();
  }, [nestedVisible]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div
        ref={content}
        aria-hidden={nestedVisible || undefined}
        // React 18 forwards the native boolean attribute as an empty string.
        {...{ inert: nestedVisible ? "" : undefined }}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          nestedVisible && "pointer-events-none opacity-0",
        )}
      >
        <header className="flex h-[60px] shrink-0 items-center gap-2 px-3">
          {onBack ? (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-md"
              aria-label="Back"
              onClick={onBack}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
          ) : null}
          {header}
        </header>
        <AgentView
          {...view}
          visible={visible && !nestedVisible}
          onOpenPanel={(target) => setNested({ target, visible: true })}
          pendingDigIn={
            nested?.target.kind === "dig-in" ? nested.target : undefined
          }
        />
      </div>
      {nested !== undefined ? (
        <div
          hidden={!nestedVisible}
          className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background [&[hidden]]:hidden"
        >
          <AgentPanelContent
            visible={visible && nestedVisible}
            transport={view.transport}
            target={nested.target}
            onBack={() => setNested(undefined)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Open an existing Session or a local Dig In draft in the same recursive panel. @example <AgentPanelContent transport={transport} target={target} onBack={close} /> */
export function AgentPanelContent({
  visible = true,
  transport,
  target,
  onBack,
  header,
}: {
  transport: AppTransport;
  visible?: boolean;
  target: AgentPanelTarget;
  onBack: () => void;
  header?: ComponentProps<typeof AgentView>["header"];
}) {
  const { agent } = useAgentContext();
  if (target.kind === "dig-in") {
    return (
      <DigInPanel
        visible={visible}
        transport={transport}
        key={digInViewKey(target)}
        target={target}
        onBack={onBack}
        header={header}
      />
    );
  }
  return (
    <AgentPanel
      visible={visible}
      transport={transport}
      key={target.sessionID}
      sessionID={target.sessionID}
      readOnly
      onSubmit={async (_sessionID, draft, model, workspaceId) => {
        await agent.submitPrompt.mutateAsync({
          sessionID: target.sessionID,
          draft,
          model,
          workspaceId,
        });
      }}
      onBack={onBack}
      header={
        header ?? (
          <span className="min-w-0 flex-1 truncate text-sm">
            {target.title}
          </span>
        )
      }
    />
  );
}

/**
 * Reuse the normal conversation surface with a local quote before its first send.
 * Each creation call makes a new child; prompt retries reuse the created child.
 * The backend alone inserts the Dig In marker and hides inherited history.
 * @example <DigInPanel transport={transport} target={target} onBack={close} />
 */
function DigInPanel({
  visible,
  transport,
  target,
  onBack,
  header,
}: {
  transport: AppTransport;
  visible: boolean;
  target: DigInTarget;
  onBack: () => void;
  header?: ComponentProps<typeof AgentView>["header"];
}) {
  const { agent } = useAgentContext();
  const creation = useMutation({
    mutationFn: () => agent.digInSession.mutateAsync(target.input),
    retry: false,
  });
  const sessionID = target.childSessionID ?? creation.data?.id;
  const hasQuestion = useSessionSnapshot(agent, sessionID, (snapshot) =>
    snapshot.messages.some((message) => message.role === "user"),
  );
  return (
    <section
      aria-label="Dig in"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <AgentPanel
        visible={visible}
        transport={transport}
        sessionID={sessionID}
        onSubmit={async (targetSessionID, draft, model, workspaceId) => {
          const childID = targetSessionID ?? (await creation.mutateAsync()).id;
          await agent.submitPrompt.mutateAsync({
            sessionID: childID,
            draft,
            model,
            workspaceId,
          });
        }}
        initialModel={target.model}
        workspaceId={target.workspaceId}
        pending={creation.isPending}
        onBack={onBack}
        header={
          header ?? (
            <span className="min-w-0 flex-1 truncate text-sm">Dig in</span>
          )
        }
        composerContext={
          hasQuestion ? undefined : (
            <QuotePreview
              text={target.input.selection.text}
              icon={SearchIcon}
              dismiss={
                <button
                  type="button"
                  aria-label="Dismiss quote"
                  onClick={onBack}
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-3.5" />
                </button>
              }
            />
          )
        }
      />
    </section>
  );
}
