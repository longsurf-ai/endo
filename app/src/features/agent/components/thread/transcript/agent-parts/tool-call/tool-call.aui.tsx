// Purpose: Adapt tool parts and native Activity metadata to tool or subagent views.
import {
  useAuiState,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { XCircleIcon } from "lucide-react";
import {
  toolAttachments,
  isImageAttachment,
} from "@openchart/app/features/agent/ag-ui/tool-media";
import {
  Screenshot,
  ScreenshotPreview,
} from "@openchart/app/features/agent/components/computer-use/screenshot";
import { formatValue } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/format-value";
import {
  AssistantTaskCard,
  type SubagentView,
} from "@openchart/app/features/agent/components/thread/transcript/agent-parts/task-card/task-card.aui";

import { ToolCall } from "./tool-call";
import { WorkflowTrace } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/workflow-trace/workflow-trace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveToolStatus(
  props: ToolCallMessagePartProps,
  activity: Record<string, unknown> | undefined,
): ToolCallMessagePartProps["status"] {
  if (props.isError || activity?.status === "error") {
    return {
      type: "incomplete",
      reason: "error",
      error: props.result ?? "Tool failed",
    };
  }
  if (props.status.type === "incomplete") {
    return props.status;
  }
  if (activity?.status === "completed" || props.result !== undefined) {
    return { type: "complete" };
  }
  // AG-UI also uses requires-action for outstanding tool results.
  // AgentThread renders actual permission requests separately.
  if (activity || props.status.type === "requires-action") {
    return { type: "running" };
  }
  return props.status;
}

/** Adapt a tool part's status, result and metadata; native subagent attribution selects TaskCard. @example <MessagePrimitive.Parts components={{ tools: { Fallback: AssistantToolCall } }} /> */
export function AssistantToolCall(props: ToolCallMessagePartProps) {
  const activities = useAuiState(
    (s) => s.message.metadata.custom.toolActivities,
  );
  const subagents = useAuiState((s) => s.message.metadata.custom.toolSubagents);
  const subagent = isRecord(subagents)
    ? (subagents[props.toolCallId] as SubagentView | undefined)
    : undefined;
  const value = isRecord(activities) ? activities[props.toolCallId] : undefined;
  const activity = isRecord(value) ? value : undefined;
  const status = resolveToolStatus(props, activity);
  const title =
    subagent?.name ??
    (typeof activity?.title === "string" ? activity?.title : props.toolName);
  if (subagent) {
    return (
      <AssistantTaskCard
        label={title}
        subagent={subagent}
        status={status}
        childSessionID={
          typeof activity?.childSessionId === "string"
            ? activity.childSessionId
            : undefined
        }
      />
    );
  }
  const cancelled =
    status.type === "incomplete" && status.reason === "cancelled";
  const result =
    status.type === "incomplete"
      ? (status.error ?? props.result)
      : props.result;
  const label =
    status.type === "incomplete"
      ? `${cancelled ? "Cancelled" : "Failed"}: ${title}`
      : title;
  const query =
    Object.values(props.args).find((value) => typeof value === "string") ?? "";
  return (
    <>
      <ToolCall
        label={label}
        activeLabel={`Running ${title}`}
        query={query}
        request={props.argsText}
        result={formatValue(result)}
        running={status.type === "running"}
        className="max-w-none"
        statusIcon={
          status.type === "incomplete" ? (
            <XCircleIcon
              className={
                cancelled
                  ? "size-3.5 text-muted-foreground"
                  : "size-3.5 text-destructive"
              }
            />
          ) : undefined
        }
      >
        {typeof activity?.childSessionId === "string" ? (
          <a
            className="text-xs text-primary underline underline-offset-4"
            href={`/app/sessions/${encodeURIComponent(activity.childSessionId)}`}
          >
            Open child conversation
          </a>
        ) : null}
        {toolAttachments(activity).map((attachment) =>
          isImageAttachment(attachment) ? (
            <ScreenshotPreview key={attachment.id} src={attachment.url}>
              <button
                type="button"
                aria-label="Enlarge tool screenshot"
                className="mt-2 block h-40 w-full max-w-xs cursor-zoom-in overflow-hidden rounded-xl border border-border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Screenshot src={attachment.url} />
              </button>
            </ScreenshotPreview>
          ) : (
            <pre
              key={attachment.id}
              className="mt-2 whitespace-pre-wrap text-xs [overflow-wrap:anywhere]"
            >
              {formatValue(attachment)}
            </pre>
          ),
        )}
      </ToolCall>
      {props.toolName === "workflow" &&
      isRecord(activity?.details) &&
      activity.details.trace !== undefined ? (
        <WorkflowTrace trace={activity.details.trace} />
      ) : null}
    </>
  );
}
