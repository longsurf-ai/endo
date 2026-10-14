// Purpose: Derive waterfall props from decoded workflow OTLP spans.
import {
  spanStatus,
  type OtelSpan,
} from "@openchart/app/lib/agent/workflow-trace";
import type {
  TraceEntry,
  TracePhase,
  TraceRow,
  TraceSpan,
} from "./trace-waterfall";

export type WorkflowTraceSpan = TraceSpan & {
  sessionID?: string;
  isPhase: boolean;
  phaseID?: string;
};

const id = (item: OtelSpan) => `${item.traceId}:${item.spanId}`;
const milliseconds = (nanos: bigint) =>
  Math.max(0, Math.round(Number(nanos) / 1e6));

/**
 * Project standard span identity, parentage, timing and status into view props.
 * Missing parents are outside this Activity; nanoseconds stay precise until subtraction.
 * @example const {spans, totalMs} = toWaterfall(otelTrace.parse(activity), Date.now());
 */
export function toWaterfall(source: OtelSpan[], now: number) {
  if (source.length === 0) return { spans: [], totalMs: 0 };
  const ordered = [...source].sort((a, b) =>
    a.startTimeUnixNano < b.startTimeUnixNano
      ? -1
      : a.startTimeUnixNano > b.startTimeUnixNano
        ? 1
        : 0,
  );
  const byId = new Map(source.map((item) => [id(item), item]));
  const origin = ordered[0]!.startTimeUnixNano;
  const spans = ordered.map((item): WorkflowTraceSpan => {
    const attributes = new Map(
      item.attributes.map(({ key, value }) => [key, value]),
    );
    const end =
      item.endTimeUnixNano === 0n
        ? BigInt(now) * 1_000_000n
        : item.endTimeUnixNano;
    const visited = new Set([id(item)]);
    let parent = item.parentSpanId;
    let depth = 0;
    let phaseID: string | undefined;
    while (parent) {
      const key = `${item.traceId}:${parent}`;
      const ancestor = byId.get(key);
      if (!ancestor || visited.has(key)) break;
      visited.add(key);
      depth++;
      if (phaseID === undefined && ancestor.name === "Workflow.phase")
        phaseID = key;
      parent = ancestor.parentSpanId;
    }
    return {
      id: id(item),
      name: attributes.get("openchart.label")?.stringValue ?? item.name,
      isAgent: item.name === "Workflow.agent",
      isPhase: item.name === "Workflow.phase",
      phaseID,
      sessionID: attributes.get("openchart.session.id")?.stringValue,
      depth,
      startMs: milliseconds(item.startTimeUnixNano - origin),
      durationMs: milliseconds(end - item.startTimeUnixNano),
      status: spanStatus(item),
    };
  });
  return {
    spans,
    totalMs: Math.max(...spans.map((item) => item.startMs + item.durationMs)),
  };
}

/**
 * Groups by the nearest phase, then by Session within that phase. Span IDs keep
 * repeated phase names distinct; nested phases retain their parent scope.
 * @example const entries = groupTrace(spans);
 */
export function groupTrace(spans: WorkflowTraceSpan[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const phases = new Map<string, TracePhase>();
  const rows = new Map<string, TraceRow>();
  for (const span of spans) {
    if (span.isPhase)
      phases.set(span.id, { kind: "phase", id: span.id, span, entries: [] });
  }
  for (const span of spans) {
    const parent = span.phaseID ? phases.get(span.phaseID) : undefined;
    const target = parent?.entries ?? entries;
    if (span.isPhase) {
      target.push(phases.get(span.id)!);
      continue;
    }
    const key = JSON.stringify([span.phaseID, span.sessionID ?? span.id]);
    const row = rows.get(key);
    if (row) row.spans.push(span);
    else {
      const entry: TraceRow = { kind: "row", id: key, spans: [span] };
      rows.set(key, entry);
      target.push(entry);
    }
  }
  return entries;
}
