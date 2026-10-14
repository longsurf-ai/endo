// Purpose: Verify OTLP timing/parentage, live rendering, and Session navigation.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { AgentViewProvider } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { toWaterfall } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/workflow-trace/otel-trace";
import { otelTrace } from "@openchart/app/lib/agent/workflow-trace";
import { WorkflowTrace } from "@openchart/app/features/agent/components/thread/transcript/agent-parts/workflow-trace/workflow-trace";
import { createTransport } from "@openchart/app/lib/transport/transport";

const transport = createTransport({ origin: location.origin });

const epoch = 1_800_000_000_000;
const nano = (ms: number) => String(BigInt(epoch + ms) * 1_000_000n);
function span(spanId: string, start: number, end: number | null, extra = {}) {
  return {
    traceId: "trace",
    spanId,
    name: spanId,
    startTimeUnixNano: nano(start),
    endTimeUnixNano: end === null ? "0" : nano(end),
    status: { code: end === null ? 0 : 1 },
    attributes: [
      {
        key: "openchart.session.id",
        value: { stringValue: `session-${spanId}` },
      },
    ],
    ...extra,
  };
}
const payload = (spans: object[]) => ({
  resourceSpans: [{ scopeSpans: [{ spans }] }],
});

afterEach(() => vi.useRealTimers());

test("OTLP parallel starts and sequential synthesis share one precise time axis", () => {
  const { spans, totalMs } = toWaterfall(
    otelTrace.parse(
      payload([
        span("synthesis", 400, 700),
        span("a", 0, 200),
        span("b", 10, 400),
        span("c", 20, 350),
      ]),
    ),
    epoch + 99999,
  );
  expect(totalMs).toBe(700);
  expect(
    spans.map(({ name, startMs, durationMs }) => ({
      name,
      startMs,
      durationMs,
    })),
  ).toEqual([
    { name: "a", startMs: 0, durationMs: 200 },
    { name: "b", startMs: 10, durationMs: 390 },
    { name: "c", startMs: 20, durationMs: 330 },
    { name: "synthesis", startMs: 400, durationMs: 300 },
  ]);
  expect(
    spans.every((item) => item.status === "completed" && item.depth === 0),
  ).toBe(true);
});

test("uses trace-qualified parent IDs, tolerates filtered parents, and maps cancellation separately from errors", () => {
  const { spans } = toWaterfall(
    otelTrace.parse(
      payload([
        span("root", 0, 1000, { parentSpanId: "outside" }),
        span("child", 10, 500, { parentSpanId: "root", status: { code: 2 } }),
        span("nested", 20, 300, {
          parentSpanId: "child",
          attributes: [
            { key: "openchart.cancelled", value: { boolValue: true } },
          ],
        }),
        span("foreign", 30, null, { traceId: "another", parentSpanId: "root" }),
      ]),
    ),
    epoch + 1000,
  );
  expect(spans.map((item) => [item.depth, item.status])).toEqual([
    [0, "completed"],
    [1, "failed"],
    [2, "cancelled"],
    [0, "running"],
  ]);
});

test("running spans grow locally and stop ticking after the terminal Activity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch + 100);
  const view = render(<WorkflowTrace trace={payload([span("a", 0, null)])} />);
  expect(
    screen.getByRole("img", { name: "running, starts at 0ms, runs 100ms" }),
  ).toBeVisible();
  await act(() => vi.advanceTimersByTime(500));
  expect(
    screen.getByRole("img", { name: "running, starts at 0ms, runs 600ms" }),
  ).toBeVisible();
  view.rerender(<WorkflowTrace trace={payload([span("a", 0, 400)])} />);
  expect(
    screen.getByRole("img", { name: "completed, starts at 0ms, runs 400ms" }),
  ).toBeVisible();
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("trace spans open their persisted Session, while unbound spans keep separate inert rows", async () => {
  const onOpen = vi.fn();
  render(
    <AgentViewProvider
      value={{
        transport,
        session: undefined,
        model: undefined,
        pending: undefined,
        onOpen,
      }}
    >
      <WorkflowTrace
        trace={payload([
          span("research", 0, 500),
          span("unbound", 10, 100, { attributes: [] }),
          span("another-unbound", 20, 200, { attributes: [] }),
        ])}
      />
    </AgentViewProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open research" }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    kind: "session",
    sessionID: "session-research",
    title: "research",
  });
  expect(screen.getByRole("button", { name: "Open unbound" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Open another-unbound" }),
  ).toBeDisabled();
  expect(screen.getAllByRole("group")).toHaveLength(3);
});

test("alternating turns share one row per Session and only individual spans activate", async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  const turns = [
    "Affirmative",
    "Negative",
    "Affirmative",
    "Negative",
    "Affirmative",
    "Negative",
  ].map((speaker, index) =>
    span(`turn-${index}`, index * 2000, index * 2000 + 1000, {
      name: "Workflow.agent",
      status: { code: index === 4 ? 2 : 1 },
      attributes: [
        { key: "openchart.session.id", value: { stringValue: speaker } },
        {
          key: "openchart.label",
          value: {
            stringValue: `${speaker} · round ${Math.floor(index / 2) + 1}`,
          },
        },
        { key: "openchart.cancelled", value: { boolValue: index === 5 } },
      ],
    }),
  );
  const view = (spans: object[]) => (
    <AgentViewProvider
      value={{
        transport,
        session: undefined,
        model: undefined,
        pending: undefined,
        onOpen,
      }}
    >
      <WorkflowTrace trace={payload(spans)} />
    </AgentViewProvider>
  );
  const { rerender } = render(view(turns.slice(0, 2)));
  const affirmativeRow = screen.getByRole("group", {
    name: "Affirmative · round 1",
  });
  rerender(view([...turns].reverse()));

  expect(screen.getAllByRole("group")).toHaveLength(2);
  expect(screen.getAllByRole("group")[0]).toBe(affirmativeRow);
  expect(within(affirmativeRow).getAllByRole("button")).toHaveLength(3);
  const negativeRow = screen.getByRole("group", { name: "Negative · round 1" });
  expect(within(negativeRow).getAllByRole("button")).toHaveLength(3);
  expect(within(affirmativeRow).getByText("3s")).toBeVisible();
  expect(
    within(affirmativeRow).getByRole("img", {
      name: "failed, starts at 8000ms, runs 1000ms",
    }),
  ).toBeVisible();
  expect(
    within(negativeRow).getByRole("img", {
      name: "cancelled, starts at 10000ms, runs 1000ms",
    }),
  ).toBeVisible();

  await user.click(affirmativeRow);
  await user.click(within(affirmativeRow).getByText("Affirmative · round 1"));
  await user.click(within(affirmativeRow).getByText("3s"));
  expect(onOpen).not.toHaveBeenCalled();

  await user.click(
    within(affirmativeRow).getByRole("button", {
      name: "Open Affirmative · round 2",
    }),
  );
  expect(onOpen).toHaveBeenLastCalledWith({
    kind: "session",
    sessionID: "Affirmative",
    title: "Affirmative · round 2",
  });
  await user.tab();
  expect(
    within(affirmativeRow).getByRole("button", {
      name: "Open Affirmative · round 3",
    }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onOpen).toHaveBeenLastCalledWith({
    kind: "session",
    sessionID: "Affirmative",
    title: "Affirmative · round 3",
  });
  await user.tab();
  await user.keyboard(" ");
  expect(onOpen).toHaveBeenLastCalledWith({
    kind: "session",
    sessionID: "Negative",
    title: "Negative · round 1",
  });
  expect(onOpen).toHaveBeenCalledTimes(3);
});

test("malformed trace metadata has a visible fallback", () => {
  render(<WorkflowTrace trace={{ resourceSpans: "invalid" }} />);
  expect(screen.getByText("Trace unavailable")).toBeVisible();
});

const phaseSpan = (
  id: string,
  name: string,
  start: number,
  end: number | null,
  extra = {},
) =>
  span(id, start, end, {
    name: "Workflow.phase",
    attributes: [{ key: "openchart.label", value: { stringValue: name } }],
    ...extra,
  });
const agentSpan = (
  id: string,
  parentSpanId: string,
  start: number,
  end: number | null,
  extra = {},
) =>
  span(id, start, end, {
    name: "Workflow.agent",
    parentSpanId,
    attributes: [
      { key: "openchart.label", value: { stringValue: id } },
      { key: "openchart.session.id", value: { stringValue: "shared-session" } },
    ],
    ...extra,
  });

test("phases group shared Sessions separately and keep one time axis and navigation", async () => {
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(
    <AgentViewProvider
      value={{
        transport,
        session: undefined,
        model: undefined,
        pending: undefined,
        onOpen,
      }}
    >
      <WorkflowTrace
        trace={payload([
          phaseSpan("round1", "Round 1", 0, 2000),
          agentSpan("First turn", "round1", 0, 2000),
          phaseSpan("round2", "Round 2", 2000, null),
          agentSpan("Second turn", "round2", 2000, null),
        ])}
      />
    </AgentViewProvider>,
  );
  expect(screen.getByRole("button", { name: "Round 1 phase" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByRole("button", { name: "Round 2 phase" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await user.click(screen.getByRole("button", { name: "Round 1 phase" }));
  expect(screen.getAllByRole("group")).toHaveLength(2);
  expect(
    screen.getByRole("img", { name: "completed, starts at 0ms, runs 2000ms" }),
  ).toBeVisible();
  expect(
    screen.getByRole("img", { name: /^running, starts at 2000ms/ }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Open First turn" }));
  await user.click(screen.getByRole("button", { name: "Open Second turn" }));
  expect(onOpen.mock.calls.map(([target]) => target.sessionID)).toEqual([
    "shared-session",
    "shared-session",
  ]);
  await user.click(screen.getByRole("button", { name: "Round 2 phase" }));
  expect(screen.getByRole("button", { name: "Round 2 phase" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("phase completion folds clean work while failures remain disclosed and counted", () => {
  const view = render(
    <WorkflowTrace
      trace={payload([
        phaseSpan("p", "Research", 0, null),
        agentSpan("Check", "p", 0, null),
      ])}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Research phase" }),
  ).toHaveAttribute("aria-expanded", "true");
  view.rerender(
    <WorkflowTrace
      trace={payload([
        phaseSpan("p", "Research", 0, 2000),
        agentSpan("Check", "p", 0, 2000),
      ])}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Research phase" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("1/1 calls completed")).toBeVisible();
  view.rerender(
    <WorkflowTrace
      trace={payload([
        phaseSpan("p", "Research", 0, 2000),
        agentSpan("Check", "p", 0, 2000, { status: { code: 2 } }),
      ])}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Research phase" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Completed")).toBeVisible();
  expect(screen.getByText("1 failed")).toBeVisible();
  expect(screen.getByText("0/1 calls completed")).toBeVisible();
});

test("nested and concurrent repeated phase names keep distinct scopes and keyboard disclosures", async () => {
  const user = userEvent.setup();
  render(
    <WorkflowTrace
      trace={payload([
        phaseSpan("root", "Research", 0, null),
        phaseSpan("a", "Check", 0, null, { parentSpanId: "root" }),
        phaseSpan("b", "Check", 1, null, { parentSpanId: "root" }),
        agentSpan("A", "a", 2, null),
        agentSpan("B", "b", 3, null),
      ])}
    />,
  );
  expect(screen.getAllByRole("button", { name: "Check phase" })).toHaveLength(
    2,
  );
  expect(screen.getAllByRole("group")).toHaveLength(2);
  expect(screen.getByText("0/2 calls completed")).toBeVisible();
  expect(screen.getAllByText("0/1 calls completed")).toHaveLength(2);
  await user.tab();
  expect(screen.getByRole("button", { name: "Research phase" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Research phase" }),
  ).toHaveAttribute("aria-expanded", "false");
});

test("cancelled and empty phases retain their actual status without inventing calls", () => {
  render(
    <WorkflowTrace
      trace={payload([
        phaseSpan("p", "Cancelled research", 0, 1000, {
          attributes: [
            {
              key: "openchart.label",
              value: { stringValue: "Cancelled research" },
            },
            { key: "openchart.cancelled", value: { boolValue: true } },
          ],
        }),
        phaseSpan("empty", "No candidates", 1000, 1001),
      ])}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Cancelled research phase" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Cancelled")).toBeVisible();
  expect(screen.queryByText(/calls completed/)).not.toBeInTheDocument();
});
