// Purpose: Render a persisted or draft text anchor and observe its child's activity.
import type { ComponentProps } from "react";
import { useAuiState } from "@assistant-ui/react";
import { ShimmerLabel } from "@openchart/app/components/ui/shimmer-label/shimmer-label";
import { useAgentContext } from "@openchart/app/lib/agent/provider";
import { useSessionSnapshot } from "@openchart/app/lib/agent/use-session-snapshot";
import {
  useAgentView,
  type DigInTarget,
} from "@openchart/app/features/agent/components/agent-view/agent-view-context";

function Marker({
  target,
  children,
  ...props
}: ComponentProps<"span"> & { target: DigInTarget }) {
  const { agent } = useAgentContext();
  const digIn = useAgentView();
  const running = useSessionSnapshot(
    agent,
    target.childSessionID,
    (snapshot) =>
      snapshot.state?.runs.some(
        (run) => run.status === "running" || run.status === "queued",
      ) ?? false,
  );
  const open = () => digIn?.onOpen?.(target);
  return (
    <span
      {...props}
      role="button"
      tabIndex={0}
      aria-busy={running}
      aria-label={`Open Dig in: ${target.input.selection.text}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // Dragging another selection across a marker must not open its panel.
        if (!window.getSelection()?.isCollapsed) return;
        open();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      className="inline cursor-pointer rounded text-start underline decoration-muted-foreground/60 decoration-2 underline-offset-[3px] outline-none transition-colors hover:decoration-foreground/95 focus-visible:ring-1 focus-visible:ring-foreground/20"
    >
      <ShimmerLabel
        active={running}
        className={running ? "text-foreground/[0.55]" : undefined}
      >
        {children}
      </ShimmerLabel>
    </span>
  );
}

/** Render Markdown spans, decorating only the anchor fragments emitted by the range plugin. @example <DigInTextSpan data-dig-in-child={childSessionID}>{text}</DigInTextSpan> */
export function DigInTextSpan(
  props: ComponentProps<"span"> & { "data-dig-in-child"?: string },
) {
  const digIn = useAgentView();
  const messageID = useAuiState(
    (s) => s.message.metadata.custom.sourceMessageId,
  );
  const childSessionID = props["data-dig-in-child"];
  const anchor = digIn?.session?.anchors?.find(
    (item) => item.childSessionId === childSessionID,
  );
  const target: DigInTarget | undefined =
    anchor && digIn?.session && typeof messageID === "string"
      ? {
          kind: "dig-in",
          input: {
            sessionID: digIn.session.id,
            messageID,
            selection: {
              partId: anchor.partId,
              text: anchor.text,
              startOffset: anchor.startOffset,
              endOffset: anchor.endOffset,
            },
          },
          childSessionID: anchor.childSessionId,
          model: digIn.model,
        }
      : childSessionID === ""
        ? digIn?.pending
        : undefined;
  return target ? <Marker {...props} target={target} /> : <span {...props} />;
}
