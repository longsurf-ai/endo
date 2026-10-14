import type { DataMessagePartProps } from "@assistant-ui/react";
import { formatValue } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/format-value";
import { ToolCall } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/tool-call/tool-call";

/** Display an ordinary Activity payload in a completed tool disclosure. @example <MessagePrimitive.Parts components={{ data: { Fallback: ActivityPart } }} /> */
export function ActivityPart({ name, data }: DataMessagePartProps) {
  const title = name.replace("openchart.", "");
  return (
    <ToolCall
      label={title}
      activeLabel={title}
      query=""
      request=""
      result={formatValue(data)}
      running={false}
      className="max-w-none"
    />
  );
}
