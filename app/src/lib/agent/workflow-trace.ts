// Purpose: Decode workflow OTLP Activity and project span lifecycles shared by trace views and bound Sessions.
import { z } from "zod";
import type { SessionSnapshot } from "./session-store";

const nanoTime = z.string().regex(/^\d+$/).transform(BigInt);
const span = z.object({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().optional(),
  name: z.string(),
  startTimeUnixNano: nanoTime,
  endTimeUnixNano: nanoTime,
  status: z.object({ code: z.number(), message: z.string().optional() }),
  attributes: z.array(
    z.object({
      key: z.string(),
      value: z.object({
        stringValue: z.string().optional(),
        boolValue: z.boolean().optional(),
      }),
    }),
  ),
});

/** Read only the OTLP fields needed by consumers; retain the full payload in Activity. */
export const otelTrace = z
  .object({
    resourceSpans: z.array(
      z.object({
        scopeSpans: z.array(z.object({ spans: z.array(span) })),
      }),
    ),
  })
  .transform((trace) =>
    trace.resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );

/** One decoded OTLP span with nanosecond bigint timestamps. */
export type OtelSpan = z.infer<typeof span>;
/** Lifecycle recorded by a span; live spans have zero end timestamps. */
export type SpanStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Project a span's recorded lifecycle without consulting clocks.
 * @example spanStatus(span) === "running"
 */
export function spanStatus(item: OtelSpan): SpanStatus {
  if (item.endTimeUnixNano === 0n) return "running";
  return item.attributes.some(
    ({ key, value }) => key === "openchart.cancelled" && value.boolValue,
  )
    ? "cancelled"
    : item.status.code === 2
      ? "failed"
      : "completed";
}

// Every observer of a parent shares one index per immutable Activity content.
const indexed = new WeakMap<object, Map<string, SpanStatus>>();
function activitySessions(content: Record<string, unknown>) {
  let sessions = indexed.get(content);
  if (!sessions) {
    sessions = new Map();
    const details = content.details as { trace?: unknown } | undefined;
    const trace = otelTrace.safeParse(details?.trace);
    const latest = new Map<string, OtelSpan>();
    for (const span of trace.success ? trace.data : []) {
      if (span.name !== "Workflow.agent") continue;
      const id = span.attributes.find(
        ({ key }) => key === "openchart.session.id",
      )?.value.stringValue;
      if (!id) continue;
      const previous = latest.get(id);
      if (!previous || previous.startTimeUnixNano <= span.startTimeUnixNano)
        latest.set(id, span);
    }
    for (const [id, span] of latest) sessions.set(id, spanStatus(span));
    indexed.set(content, sessions);
  }
  return sessions;
}

/**
 * Status of the latest workflow agent call that ran `sessionId`, read from the
 * parent's loaded tool Activities. Workflow children own no Run, so this span
 * supplies live progress; durable completion also belongs to the child transcript. Undefined when no loaded span names the Session.
 * Pure; Session statuses are indexed once per Activity content.
 * @example const status = workflowSessionStatus(parentSnapshot, childId);
 */
export function workflowSessionStatus(
  parent: SessionSnapshot,
  sessionId: string,
): SpanStatus | undefined {
  for (let index = parent.messages.length - 1; index >= 0; index--) {
    const message = parent.messages[index]!;
    if (
      message.role !== "activity" ||
      message.activityType !== "openchart.tool"
    )
      continue;
    const status = activitySessions(message.content).get(sessionId);
    if (status) return status;
  }
  return undefined;
}
