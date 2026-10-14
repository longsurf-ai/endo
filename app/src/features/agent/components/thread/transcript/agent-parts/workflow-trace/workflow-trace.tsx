// Purpose: Connect persisted workflow Activity spans to the waterfall and host panel.
import { useEffect, useMemo, useState } from "react";
import { useAgentView } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { otelTrace } from "@openchart/app/lib/agent/workflow-trace";
import { groupTrace, toWaterfall } from "./otel-trace";
import { TraceWaterfall } from "./trace-waterfall";

/** Render the trace carried by an ordinary workflow tool Activity. @example <WorkflowTrace trace={activity.details.trace} /> */
export function WorkflowTrace({ trace }: { trace: unknown }) {
  const decoded = useMemo(() => otelTrace.safeParse(trace), [trace]);
  if (!decoded.success) {
    return <p className="text-xs text-muted-foreground">Trace unavailable</p>;
  }
  return <LiveTrace source={decoded.data} />;
}

function LiveTrace({ source }: { source: ReturnType<typeof otelTrace.parse> }) {
  const onOpen = useAgentView()?.onOpen;
  const [now, setNow] = useState(Date.now);
  const running = source.some((span) => span.endTimeUnixNano === 0n);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  const { spans, totalMs } = toWaterfall(source, now);
  if (spans.length === 0) return null;
  const entries = groupTrace(
    spans.map((span) => {
      const sessionID = span.sessionID;
      return {
        ...span,
        onActivate:
          sessionID && onOpen
            ? () => onOpen({ kind: "session", sessionID, title: span.name })
            : undefined,
      };
    }),
  );
  return (
    <TraceWaterfall
      className="my-1 max-w-none"
      data-aui-quote-selectable="false"
      aria-label="Workflow trace"
      entries={entries}
      totalMs={totalMs}
    />
  );
}
