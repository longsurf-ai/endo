// Purpose: Show native subagent status and open its existing child conversation.
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";

import { TaskCard } from "./task-card";

export type SubagentView = {
  name: string;
  running: boolean;
  error?: string;
};

/** Show a subagent's title and lifecycle without exposing its results or child transcript. @example <AssistantTaskCard label="Research" subagent={{ name: "Research", running: true }} status={{ type: "running" }} /> */
export function AssistantTaskCard({
  label,
  subagent,
  status,
  childSessionID,
}: {
  label: string;
  subagent: SubagentView;
  status: ToolCallMessagePartProps["status"];
  childSessionID?: string;
}) {
  const onOpen = useAgentView()?.onOpen;
  const cancelled =
    status.type === "incomplete" && status.reason === "cancelled";
  const state = cancelled
    ? "cancelled"
    : subagent.error !== undefined || status.type === "incomplete"
      ? "failed"
      : subagent.running
        ? "working"
        : "done";
  return (
    <TaskCard
      className="my-1"
      data-aui-quote-selectable="false"
      role="group"
      aria-label={`Subagent: ${label}`}
      label={label}
      state={state}
      onActivate={
        childSessionID && onOpen
          ? () =>
              onOpen({
                kind: "session",
                sessionID: childSessionID,
                title: label,
              })
          : undefined
      }
    />
  );
}
