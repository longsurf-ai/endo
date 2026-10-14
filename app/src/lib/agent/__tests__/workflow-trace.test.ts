// Purpose: Verify workflow children read their lifecycle from the parent's trace span.
import { expect, test } from "vitest";
import type { SessionSnapshot } from "@openchart/app/lib/agent/session-store";
import { workflowSessionStatus } from "@openchart/app/lib/agent/workflow-trace";

function agentSpan(
  spanId: string,
  sessionId: string,
  start: number,
  end: number,
  extra: { code?: number; cancelled?: boolean } = {},
) {
  return {
    traceId: "trace",
    spanId,
    name: "Workflow.agent",
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(end),
    status: { code: extra.code ?? 1 },
    attributes: [
      { key: "openchart.session.id", value: { stringValue: sessionId } },
      ...(extra.cancelled
        ? [{ key: "openchart.cancelled", value: { boolValue: true } }]
        : []),
    ],
  };
}

function parent(...spans: ReturnType<typeof agentSpan>[][]): SessionSnapshot {
  return {
    history: { hasMore: false, loading: false, error: undefined },
    loading: false,
    error: undefined,
    subagents: {},
    state: undefined,
    messages: spans.map((items, index) => ({
      id: `activity_${index}`,
      role: "activity",
      activityType: "openchart.tool",
      content: {
        toolCallId: `call_${index}`,
        status: "running",
        details: {
          trace: { resourceSpans: [{ scopeSpans: [{ spans: items }] }] },
        },
      },
    })),
  };
}

test("reads each child's latest span, including terminal outcomes", () => {
  const snapshot = parent(
    [agentSpan("a", "ses_a", 1, 5), agentSpan("b", "ses_b", 1, 0)],
    [
      agentSpan("c", "ses_a", 10, 0),
      agentSpan("d", "ses_c", 10, 20, { code: 2 }),
      agentSpan("e", "ses_d", 10, 20, { cancelled: true }),
    ],
  );
  expect(workflowSessionStatus(snapshot, "ses_a")).toBe("running");
  expect(workflowSessionStatus(snapshot, "ses_b")).toBe("running");
  expect(workflowSessionStatus(snapshot, "ses_c")).toBe("failed");
  expect(workflowSessionStatus(snapshot, "ses_d")).toBe("cancelled");
  expect(workflowSessionStatus(snapshot, "ses_missing")).toBeUndefined();
  expect(
    workflowSessionStatus(parent([agentSpan("f", "ses_a", 1, 5)]), "ses_a"),
  ).toBe("completed");
});
