// Purpose: Verify OpenChart content survives the upstream presentation boundary.
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { act, render, screen, within } from "@testing-library/react";
import { EventType, type Message } from "@ag-ui/core";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { convertMessages } from "@openchart/app/features/agent/ag-ui/react/assistant-ui-messages";
import { addMessageMetadata } from "@openchart/app/features/agent/ag-ui/react/assistant-ui-message-metadata";
import type { Subagent } from "@openchart/app/lib/agent/session-store";

import { AgentTranscript } from "@openchart/app/features/agent/components/thread/transcript/transcript";
import { BranchAction } from "@openchart/app/features/agent/components/thread/transcript/branch-action";
import { AgentViewProvider } from "@openchart/app/features/agent/components/agent-view/agent-view-context";
import { createTransport } from "@openchart/app/lib/transport/transport";

const transport = createTransport({ origin: location.origin });

const forkSession = vi.fn(async () => {});

const convertMessage = (message: ThreadMessageLike) => message;

test("does not create an empty work disclosure before a text-only final reply", () => {
  render(
    <Conversation
      messages={convertMessages([
        { id: "user", role: "user", content: "Hello" },
        { id: "empty", role: "assistant", content: "" },
        { id: "answer", role: "assistant", content: "Hello back" },
      ])}
    />,
  );
  expect(screen.getByText("Hello back")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /^Worked/ }),
  ).not.toBeInTheDocument();
});

test("shows workflow-only user input in a SpecSheet during execution and after reload", () => {
  const messages: Message[] = [
    {
      id: "workflow-input",
      role: "user",
      content: "",
      metadata: {
        parts: [
          {
            type: "workflow",
            workflow: "default:workflows/best-of-n.workflow.ts",
            args: { n: 3, question: "Look into Google" },
          },
        ],
      },
    },
  ];
  const view = render(
    <Conversation messages={convertMessages(messages, true)} running />,
  );
  const sheet = screen.getByRole("group", {
    name: "Workflow: default:workflows/best-of-n.workflow.ts",
  });
  expect(sheet).toBeVisible();
  expect(sheet).toHaveAttribute("data-slot", "spec-sheet");
  for (const text of ["n", "3", "question", "Look into Google"])
    expect(within(sheet).getByText(text)).toBeVisible();

  messages.push({
    id: "answer",
    role: "assistant",
    content: "Research complete",
  });
  view.unmount();
  render(
    <Conversation messages={convertMessages(structuredClone(messages))} />,
  );
  expect(
    screen.getAllByText("default:workflows/best-of-n.workflow.ts"),
  ).toHaveLength(1);
  expect(screen.getByText("Look into Google")).toBeVisible();
  expect(screen.getByText("Research complete")).toBeVisible();
});

test("shows every workflow argument, including structured and falsy JSON values", () => {
  const args = {
    question: "Compare Google\nand Microsoft",
    options: { regions: ["US", "EU"] },
    enabled: false,
    limit: 0,
    cursor: null,
  };
  render(
    <Conversation
      messages={convertMessages([
        {
          id: "workflow-input",
          role: "user",
          content: "",
          metadata: {
            parts: [
              {
                type: "workflow",
                workflow: "workspace:research.workflow.ts",
                args,
              },
            ],
          },
        },
      ])}
    />,
  );
  expect(screen.getByText("workspace:research.workflow.ts")).toBeVisible();
  for (const label of Object.keys(args))
    expect(screen.getByText(label)).toBeVisible();
  for (const value of [
    "Compare Google and Microsoft",
    '{ "regions": [ "US", "EU" ] }',
    "false",
    "0",
    "null",
  ])
    expect(screen.getByText(value)).toBeVisible();
});

test.each([false, true])(
  "compaction (auto=%s) replaces its indicator with a permanent boundary, including after reload",
  (auto) => {
    const messages: Message[] = [
      { id: "question", role: "user", content: "Earlier question" },
      { id: "answer", role: "assistant", content: "Earlier answer" },
      {
        id: "marker",
        role: "user",
        content: "",
        metadata: { parts: [{ type: "compaction", auto }] },
      },
      {
        id: "summary-text",
        role: "assistant",
        content: "Internal summary",
        metadata: { openchart: { messageId: "summary" } },
      },
    ];
    const header = {
      completedAt: null as number | null,
      finish: null as string | null,
      error: null,
      compaction: { userMessageId: "marker", summary: false },
    };
    const converted = () =>
      convertMessages(messages, true, {}, { summary: header });
    const view = render(<Conversation messages={converted()} running />);
    expect(screen.getByRole("status")).toHaveTextContent("Compacting…");
    expect(screen.queryByText("Internal summary")).not.toBeInTheDocument();
    expect(screen.queryByText("Context compacted")).not.toBeInTheDocument();

    // Finishing the model stream alone does not seal the compaction.
    header.completedAt = 20;
    header.finish = "stop";
    if (auto) messages.push({ id: "continuation", role: "user", content: "" });
    view.rerender(<Conversation messages={converted()} running />);
    expect(screen.getByRole("status")).toHaveTextContent("Compacting…");
    header.compaction.summary = true;
    expect(
      converted().find((message) => message.id === "marker")?.metadata?.custom
        ?.sourceMessageId,
    ).toBe("summary");
    view.rerender(<Conversation messages={converted()} running />);
    expect(screen.getByText("Context compacted")).toBeVisible();
    expect(screen.queryByText("Compacting…")).not.toBeInTheDocument();

    messages.push(
      { id: "next-question", role: "user", content: "Another question" },
      { id: "next-answer", role: "assistant", content: "Another answer" },
    );
    view.unmount();
    render(
      <Conversation
        messages={convertMessages(messages, false, {}, { summary: header })}
      />,
    );
    expect(screen.getAllByText("Context compacted")).toHaveLength(1);
    expect(screen.getByText("Earlier answer")).toBeVisible();
    expect(screen.getByText("Another answer")).toBeVisible();
    expect(screen.queryByText("Internal summary")).not.toBeInTheDocument();
  },
);

test.each([undefined, "length", "stop"])(
  "an unsealed or interrupted summary (%s) never shows a completed label",
  (finish) => {
    const messages: Message[] = [
      {
        id: "marker",
        role: "user",
        content: "",
        metadata: { parts: [{ type: "compaction", auto: false }] },
      },
      {
        id: "partial",
        role: "assistant",
        content: "Partial summary",
        metadata: { openchart: { messageId: "summary" } },
      },
      { id: "later", role: "user", content: "A new task" },
    ];
    const messageInfo = {
      summary: {
        completedAt: 20,
        finish,
        compaction: { userMessageId: "marker", summary: false },
      },
    };
    render(
      <Conversation
        messages={convertMessages(messages, true, {}, messageInfo)}
        running
      />,
    );
    expect(screen.getByText("Context compaction incomplete")).toBeVisible();
    expect(screen.queryByText("Compacting…")).not.toBeInTheDocument();
    expect(screen.queryByText("Context compacted")).not.toBeInTheDocument();
    expect(screen.queryByText("Partial summary")).not.toBeInTheDocument();
  },
);

test("a provider child with empty input renders its reply without an empty bubble or copy action", () => {
  render(
    <Conversation
      messages={convertMessages([
        { id: "delegate-input", role: "user", content: "" },
        { id: "delegate-answer", role: "assistant", content: "Child answer" },
      ])}
    />,
  );
  expect(screen.getByText("Child answer")).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(
    1,
  );
});

test("keeps attachment-only user messages when hiding empty provider inputs", () => {
  render(
    <Conversation
      messages={convertMessages([
        {
          id: "image-input",
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                value: "https://example.test/chart.png",
                mimeType: "image/png",
              },
            },
          ],
        },
        { id: "image-answer", role: "assistant", content: "Image received" },
      ])}
    />,
  );
  expect(screen.getByText("Image received")).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(
    2,
  );
});

test("renders structured user quotes with the official QuoteBlock above the prompt", () => {
  render(
    <Conversation
      messages={convertMessages([
        {
          id: "user",
          role: "user",
          content: "Explain this",
          metadata: {
            parts: [
              {
                type: "context",
                context: { kind: "quote", text: "Selected reply" },
              },
              { type: "text", text: "Explain this" },
            ],
          },
        },
      ])}
    />,
  );
  expect(screen.getAllByText("Selected reply")).toHaveLength(1);
  expect(screen.getByText("Selected reply")).toHaveAttribute(
    "data-slot",
    "quote-block-text",
  );
  expect(screen.getByText("Explain this")).toBeVisible();
  expect(screen.queryByText("> Selected reply")).not.toBeInTheDocument();
});

// jsdom has no layout or scrolling; real viewport behavior is checked in Desktop.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});
afterAll(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

function Conversation({
  messages,
  running = false,
}: {
  messages: ThreadMessageLike[];
  running?: boolean;
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: running,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <AgentTranscript
            messageActions={
              <BranchAction onFork={forkSession} pending={false} />
            }
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

test("shows live backend thinking in one line and falls back until content arrives", () => {
  const view = render(
    <Conversation
      running
      messages={[{ id: "reply", role: "assistant", content: [] }]}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Thinking");

  view.rerender(
    <Conversation
      running
      messages={[
        {
          id: "reply",
          role: "assistant",
          content: [{ type: "reasoning", text: " \n " }],
        },
      ]}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Thinking");

  view.rerender(
    <Conversation
      running
      messages={[
        {
          id: "reply",
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Earlier thought.\n\n**Comparing market data**\nChecking volume.",
            },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Comparing market data Checking volume.",
  );
  expect(screen.queryByText("Earlier thought.")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /Reasoning/ }),
  ).not.toBeInTheDocument();

  view.rerender(
    <Conversation
      messages={[
        {
          id: "reply",
          role: "assistant",
          content: [{ type: "reasoning", text: "Finished reasoning" }],
        },
      ]}
    />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  // An unfinished run keeps its recorded work available rather than hiding it.
  expect(screen.getByText("Finished reasoning")).toBeVisible();
});

test("uses message timestamps across live remounts and completion, then folds the whole turn", async () => {
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setInterval",
      "clearInterval",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  try {
    vi.setSystemTime(1000);
    const waiting: ThreadMessageLike[] = [
      { id: "user", role: "user", content: "Check prices" },
      { id: "thinking", role: "assistant", content: [] },
    ];
    let view = render(<Conversation running messages={waiting} />);
    await act(() => vi.advanceTimersByTime(12000));
    expect(
      screen.queryByRole("button", { name: /Working for/ }),
    ).not.toBeInTheDocument();
    const thinking: ThreadMessageLike[] = [
      waiting[0]!,
      {
        id: "thinking",
        role: "assistant",
        content: [{ type: "reasoning", text: "Checking prices" }],
        metadata: {
          custom: { sourceCreatedAt: 1000, sourceCompletedAt: 12000 },
        },
      },
    ];
    view.rerender(<Conversation running messages={thinking} />);
    expect(
      screen.getByRole("button", { name: "Working for 12s" }),
    ).toHaveAttribute("aria-expanded", "true");
    await act(() => vi.advanceTimersByTime(3000));
    const work: ThreadMessageLike[] = [
      ...thinking,
      {
        id: "lookup",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "lookup",
            toolName: "lookup",
            args: {},
            argsText: "{}",
            result: "Found prices",
          },
        ],
      },
    ];
    view.rerender(<Conversation running messages={work} />);
    expect(
      screen.getByRole("button", { name: "Working for 15s" }),
    ).toBeVisible();
    view.unmount();
    await act(() => vi.advanceTimersByTime(2000));
    view = render(<Conversation running messages={work} />);
    expect(
      screen.getByRole("button", { name: "Working for 17s" }),
    ).toBeVisible();
    view.rerender(<Conversation messages={work} />);
    expect(screen.getByRole("button", { name: "Worked" })).toBeVisible();
    view.rerender(
      <Conversation
        messages={[
          ...work,
          {
            id: "answer",
            role: "assistant",
            content: "Final price comparison",
            metadata: {
              custom: {
                finalReplyStartIndex: 0,
                showActions: true,
                sourceCompletedAt: 17500,
              },
            },
          },
        ]}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Worked for 16s" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Final price comparison")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Copy message" }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "lookup" }),
    ).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTime(7000));
    await userEvent.click(
      screen.getByRole("button", { name: "Worked for 16s" }),
    );
    expect(screen.getByText("Checking prices")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "lookup" }));
    expect(screen.getByText("Found prices")).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

test("history infers the whole turn duration from saved timestamps, including after remount", () => {
  const messages: Message[] = [
    {
      id: "user",
      role: "user",
      content: "Check prices",
      metadata: { openchart: { messageId: "user", createdAt: 0 } },
    },
    {
      id: "thinking",
      role: "reasoning",
      content: "Checking sources",
      metadata: { openchart: { messageId: "first", createdAt: 1000 } },
    },
    {
      id: "tool",
      role: "assistant",
      toolCalls: [
        {
          id: "search",
          type: "function",
          function: { name: "search", arguments: "{}" },
          metadata: { openchart: { messageId: "first", createdAt: 1000 } },
        },
      ],
    },
    { id: "result", role: "tool", toolCallId: "search", content: "Evidence" },
    {
      id: "answer",
      role: "assistant",
      content: "The final answer",
      metadata: { openchart: { messageId: "last", createdAt: 7000 } },
    },
  ];
  const view = render(
    <Conversation
      messages={convertMessages(
        messages,
        false,
        {},
        {
          first: { completedAt: 4000 },
          last: { completedAt: null },
        },
      )}
    />,
  );
  expect(screen.getByRole("button", { name: "Worked" })).toBeVisible();
  const completed = convertMessages(
    messages,
    false,
    {},
    {
      first: { completedAt: 4000 },
      last: { completedAt: 14500 },
    },
  );
  view.rerender(<Conversation messages={completed} />);
  expect(
    screen.getByRole("button", { name: "Worked for 13s" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("The final answer")).toBeVisible();
  view.unmount();
  render(<Conversation messages={completed} />);
  expect(
    screen.getByRole("button", { name: "Worked for 13s" }),
  ).toHaveAttribute("aria-expanded", "false");
});

test("history infers the duration of a turn that starts with a tool call", () => {
  const source = { messageId: "first", createdAt: 1000 };
  const messages: Message[] = [
    {
      id: "user",
      role: "user",
      content: "Run the debate",
      metadata: { openchart: { messageId: "user", createdAt: 0 } },
    },
    {
      id: "tool",
      role: "assistant",
      toolCalls: [
        {
          id: "workflow",
          type: "function",
          function: { name: "workflow", arguments: "{}" },
          metadata: { openchart: source },
        },
      ],
    },
    {
      id: "result",
      role: "tool",
      toolCallId: "workflow",
      content: "Debate complete",
      metadata: { openchart: source },
    },
    {
      id: "answer",
      role: "assistant",
      content: "The final answer",
      metadata: { openchart: { messageId: "last", createdAt: 7000 } },
    },
  ];
  render(
    <Conversation
      messages={convertMessages(
        messages,
        false,
        {},
        {
          first: { completedAt: 6000 },
          last: { completedAt: 9500 },
        },
      )}
    />,
  );
  expect(screen.getByRole("button", { name: "Worked for 8s" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByText("The final answer")).toBeVisible();
});

test("history folds mixed reasoning/tools while preserving the answer within the same message", async () => {
  render(
    <Conversation
      messages={addMessageMetadata(
        [
          {
            id: "reply",
            role: "assistant",
            content: [
              { type: "text", text: "  " },
              { type: "text", text: "Let me check" },
              { type: "text", text: "The final answer" },
              { type: "reasoning", text: "Comparing sources" },
              {
                type: "tool-call",
                toolCallId: "search",
                toolName: "search",
                args: {},
                argsText: "{}",
                result: "Evidence",
              },
              { type: "text", text: "The final answer" },
              { type: "reasoning", text: "" },
            ],
          },
        ],
        [],
        false,
        true,
        {},
      )}
    />,
  );
  expect(screen.getByRole("button", { name: "Worked" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.getByText("The final answer")).toBeVisible();
  expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(
    1,
  );
  expect(screen.queryByText("Let me check")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Worked" }));
  expect(screen.getByText("Let me check")).toBeVisible();
  expect(screen.getByText("Comparing sources")).toBeVisible();
});

test("does not automatically hide failed or outstanding tools behind a reply", () => {
  render(
    <Conversation
      messages={[
        {
          id: "reply",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "pending",
              toolName: "pending",
              args: {},
              argsText: "{}",
            },
            { type: "text", text: "Still checking" },
          ],
          metadata: { custom: { finalReplyStartIndex: 1 } },
        },
      ]}
    />,
  );
  expect(screen.getByRole("button", { name: "Worked" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.getByRole("button", { name: /pending/ })).toBeVisible();
  expect(screen.getByText("Still checking")).toBeVisible();
});

test("keeps tools independent as thinking gives way to tools and the reply", async () => {
  const reasoning = { type: "reasoning", text: "Looking up prices" } as const;
  const tool = {
    type: "tool-call",
    toolCallId: "lookup",
    toolName: "lookup",
    args: {},
    argsText: "{}",
  } as const;
  const view = render(
    <Conversation
      running
      messages={[
        { id: "reply", role: "assistant", content: [reasoning, tool] },
      ]}
    />,
  );
  expect(screen.getByRole("status", { name: "Working" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /lookup/ }));
  expect(await screen.findByText("{}")).toBeVisible();

  view.rerender(
    <Conversation
      running
      messages={[
        {
          id: "reply",
          role: "assistant",
          content: [
            reasoning,
            { ...tool, result: "Found prices" },
            { type: "reasoning", text: "Comparing the results" },
          ],
        },
      ]}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Comparing the results");
  expect(screen.getByText("Found prices")).toBeVisible();

  view.rerender(
    <Conversation
      running
      messages={[
        {
          id: "reply",
          role: "assistant",
          content: [
            reasoning,
            { ...tool, result: "Found prices" },
            { type: "reasoning", text: "Comparing the results" },
            { type: "text", text: "Here is the comparison." },
          ],
        },
      ]}
    />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(await screen.findByText("Here is the comparison.")).toBeVisible();
  expect(screen.getByText("Found prices")).toBeVisible();
});

test("keeps one progress dot after tools finish until the run ends, even across completed messages", () => {
  const tool = {
    type: "tool-call",
    toolCallId: "lookup",
    toolName: "lookup",
    args: {},
    argsText: "{}",
    result: "Found prices",
  } as const;
  const messages: ThreadMessageLike[] = [
    {
      id: "first-step",
      role: "assistant",
      content: [tool],
      status: { type: "complete", reason: "unknown" },
    },
    {
      id: "second-step",
      role: "assistant",
      content: [{ ...tool, toolCallId: "second-lookup" }],
      status: { type: "complete", reason: "unknown" },
    },
  ];
  const view = render(<Conversation running messages={messages} />);
  expect(screen.getAllByRole("status", { name: "Working" })).toHaveLength(1);
  view.rerender(<Conversation messages={messages} />);
  expect(
    screen.queryByRole("status", { name: "Working" }),
  ).not.toBeInTheDocument();
});

test.each([undefined, "pending", "running"])(
  "shows an outstanding tool as running until its result arrives (Activity: %s)",
  (status) => {
    const messages: Message[] = [
      {
        id: "assistant",
        role: "assistant",
        toolCalls: [
          {
            id: "lookup",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          },
        ],
      },
      ...(status === undefined
        ? []
        : [
            {
              id: "activity",
              role: "activity" as const,
              activityType: "openchart.tool",
              content: { toolCallId: "lookup", status },
            },
          ]),
    ];
    const view = render(
      <Conversation running messages={convertMessages(messages, true)} />,
    );
    expect(
      screen.getByRole("button", { name: "Running lookup" }),
    ).toBeVisible();
    expect(screen.queryByText(/Waiting for approval/)).not.toBeInTheDocument();

    view.rerender(
      <Conversation
        running
        messages={convertMessages(
          [
            ...messages,
            {
              id: "result",
              role: "tool",
              toolCallId: "lookup",
              content: "Found prices",
            },
          ],
          true,
        )}
      />,
    );
    expect(screen.getByRole("button", { name: "lookup" })).toBeVisible();
  },
);

test("workflow Activity details render a navigable trace through the ordinary tool fallback", async () => {
  const onOpen = vi.fn();
  const trace = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: "trace",
                spanId: "research",
                name: "Workflow.agent",
                startTimeUnixNano: "1800000000000000000",
                endTimeUnixNano: "1800000000100000000",
                status: { code: 1 },
                attributes: [
                  {
                    key: "openchart.label",
                    value: { stringValue: "Research evidence" },
                  },
                  {
                    key: "openchart.session.id",
                    value: { stringValue: "research-session" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
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
      <Conversation
        messages={convertMessages([
          {
            id: "assistant",
            role: "assistant",
            toolCalls: [
              {
                id: "workflow",
                type: "function",
                function: { name: "workflow", arguments: "{}" },
              },
            ],
          },
          {
            id: "activity",
            role: "activity",
            activityType: "openchart.tool",
            content: {
              toolCallId: "workflow",
              status: "completed",
              title: "Workflow · best-of-three@1",
              details: { trace },
            },
          },
          {
            id: "result",
            role: "tool",
            toolCallId: "workflow",
            content: "Completed",
          },
        ])}
      />
    </AgentViewProvider>,
  );
  expect(screen.getByText("Workflow")).toBeVisible();
  expect(
    screen.getByRole("img", { name: "completed, starts at 0ms, runs 100ms" }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Open Research evidence" }),
  );
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    kind: "session",
    sessionID: "research-session",
    title: "Research evidence",
  });
});

test("hides raw tool progress while showing results and ordinary activities in upstream tool cards", async () => {
  render(
    <Conversation
      messages={[
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "lookup",
              toolName: "lookup",
              args: {},
              argsText: "{}",
              result: "Lookup result",
            },
            { type: "data", name: "openchart.notice", data: "Activity result" },
          ],
          metadata: {
            custom: {
              toolActivities: {
                lookup: {
                  title: "Find prices",
                  status: "completed",
                  details: "Read 2 rows",
                  childSessionId: "child-session",
                },
              },
            },
          },
        },
      ]}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Find prices/ }));
  expect(screen.queryByLabelText("Tool progress")).not.toBeInTheDocument();
  expect(screen.queryByText("Read 2 rows")).not.toBeInTheDocument();
  expect(screen.getByText("Request")).toBeVisible();
  expect(screen.getByText("Result")).toBeVisible();
  expect(screen.getByText("Lookup result")).toBeVisible();
  expect(
    screen.getByRole("link", { name: "Open child conversation" }),
  ).toHaveAttribute("href", "/app/sessions/child-session");
  await userEvent.click(screen.getByRole("button", { name: /notice/ }));
  expect(await screen.findByText("Activity result")).toBeVisible();
});

test("keeps failed tool results visible without native Activity metadata", async () => {
  render(
    <Conversation
      messages={[
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "failed",
              toolName: "lookup",
              args: {},
              argsText: "{}",
              isError: true,
              result: "Provider unavailable",
            },
          ],
        },
      ]}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /lookup/ }));
  expect(
    screen.getByRole("button", { name: "Failed: lookup" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(await screen.findByText("Provider unavailable")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Failed: lookup" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Provider unavailable")).not.toBeInTheDocument();
});

test("workflow traces survive the transcript adapter, terminal updates and reload with child navigation", async () => {
  const onOpen = vi.fn();
  const messages = (completed: boolean): Message[] => [
    {
      id: "workflow-call",
      role: "assistant",
      toolCalls: [
        {
          id: "workflow",
          type: "function",
          function: { name: "workflow", arguments: "{}" },
        },
      ],
    },
    {
      id: "workflow-activity",
      role: "activity",
      activityType: "openchart.tool",
      content: {
        toolCallId: "workflow",
        status: completed ? "completed" : "running",
        title: "Workflow · research@1",
        details: {
          trace: {
            resourceSpans: [
              {
                scopeSpans: [
                  {
                    spans: [
                      {
                        traceId: "trace",
                        spanId: "research",
                        name: "Workflow.agent",
                        startTimeUnixNano: "1000000000",
                        endTimeUnixNano: completed ? "2000000000" : "0",
                        status: { code: completed ? 1 : 0 },
                        attributes: [
                          {
                            key: "openchart.label",
                            value: { stringValue: "Research step" },
                          },
                          {
                            key: "openchart.session.id",
                            value: { stringValue: "ses_research" },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
    ...(completed
      ? [
          {
            id: "workflow-result",
            role: "tool" as const,
            toolCallId: "workflow",
            content: "",
          },
        ]
      : []),
  ];
  const conversation = (completed: boolean) => (
    <AgentViewProvider
      value={{
        transport,
        session: undefined,
        model: undefined,
        pending: undefined,
        onOpen,
      }}
    >
      <Conversation
        messages={convertMessages(messages(completed), !completed)}
        running={!completed}
      />
    </AgentViewProvider>
  );
  const view = render(conversation(false));
  expect(
    screen.getByRole("button", { name: "Open Research step" }),
  ).toBeVisible();
  expect(
    screen.getByRole("img", { name: /^running, starts at 0ms/ }),
  ).toBeVisible();
  view.rerender(conversation(true));
  expect(
    screen.getByRole("img", { name: "completed, starts at 0ms, runs 1000ms" }),
  ).toBeVisible();
  view.unmount();
  render(conversation(true));
  expect(
    screen.getByRole("img", { name: "completed, starts at 0ms, runs 1000ms" }),
  ).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Open Research step" }),
  );
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    kind: "session",
    sessionID: "ses_research",
    title: "Research step",
  });
  expect(screen.queryByText("Request")).not.toBeInTheDocument();
  expect(screen.queryByText("Result")).not.toBeInTheDocument();
});

test("renders a truncated JSON result as text through the existing tool disclosure", async () => {
  const preview = '{"body":"' + "x".repeat(491) + "\n… [truncated]";
  render(
    <Conversation
      messages={convertMessages([
        {
          id: "call",
          role: "assistant",
          toolCalls: [
            {
              id: "read",
              type: "function",
              function: { name: "Read", arguments: "{}" },
            },
          ],
        },
        { id: "result", role: "tool", toolCallId: "read", content: preview },
      ])}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Read" }));
  expect(await screen.findByText(/… \[truncated\]/)).toBeVisible();
  expect(screen.queryByText("Trace unavailable")).not.toBeInTheDocument();
});

const delegateStart: Subagent["start"] = {
  type: EventType.SUBAGENT_STARTED,
  subagentRunId: "child",
  name: "Research assistant",
  parentToolCallId: "delegate",
};

const delegateMessages: Message[] = [
  {
    id: "tools",
    role: "assistant",
    toolCalls: [
      {
        id: "lookup",
        type: "function",
        function: { name: "Agent", arguments: "{}" },
      },
      {
        id: "delegate",
        type: "function",
        function: { name: "Agent", arguments: "{}" },
      },
    ],
  },
  {
    id: "lookup-result",
    role: "tool",
    toolCallId: "lookup",
    content: "Lookup result",
  },
  {
    id: "child-text",
    role: "assistant",
    subagentRunId: "child",
    content: "Child-only reply",
  },
];

test("TaskCard becomes navigable when Activity supplies its child Session, without exposing the child inline", async () => {
  const onOpen = vi.fn();
  const conversation = (linked: boolean) => (
    <AgentViewProvider
      value={{
        transport,
        session: undefined,
        model: undefined,
        pending: undefined,
        onOpen,
      }}
    >
      <Conversation
        messages={convertMessages(
          [
            ...delegateMessages,
            ...(linked
              ? [
                  {
                    id: "activity",
                    role: "activity" as const,
                    activityType: "openchart.tool",
                    content: {
                      toolCallId: "delegate",
                      childSessionId: "persisted-child-session",
                      status: "running",
                    },
                  },
                ]
              : []),
          ],
          true,
          { child: { start: delegateStart } },
        )}
      />
    </AgentViewProvider>
  );
  const view = render(conversation(false));
  const button = within(
    screen.getByRole("group", { name: "Subagent: Research assistant" }),
  ).getByRole("button");
  expect(button).toBeDisabled();
  view.rerender(conversation(true));
  expect(button).toBeEnabled();
  expect(button).not.toHaveAttribute("aria-expanded");
  await userEvent.click(button);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith({
    kind: "session",
    sessionID: "persisted-child-session",
    title: "Research assistant",
  });
  expect(screen.queryByText("Child-only reply")).not.toBeInTheDocument();
});

test.each([false, true])(
  "keeps TaskCards inert without host navigation and routes ordinary calls to ToolCall (Activity: %s)",
  async (withActivity) => {
    const messages: Message[] = [
      ...delegateMessages,
      ...(withActivity
        ? [
            {
              id: "delegate-activity",
              role: "activity" as const,
              activityType: "openchart.tool",
              content: {
                toolCallId: "delegate",
                status: "running",
                childSessionId: "child-session",
              },
            },
          ]
        : []),
    ];
    const view = render(
      <Conversation
        running
        messages={convertMessages(messages, true, {
          child: { start: delegateStart },
        })}
      />,
    );
    const task = screen.getByRole("group", {
      name: "Subagent: Research assistant",
    });
    expect(task).toHaveAttribute("data-slot", "task-card");
    expect(task).toHaveAttribute("data-state", "working");
    const header = within(task).getByRole("button", {
      name: /Research assistant/,
    });
    expect(header).toBeDisabled();
    expect(header).not.toHaveAttribute("aria-expanded");
    await userEvent.click(header);
    expect(screen.queryByText("Child-only reply")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open child conversation" }),
    ).not.toBeInTheDocument();

    // Both calls have the same provider tool name: native attribution owns routing.
    const ordinary = screen.getByRole("button", { name: "Agent" });
    expect(ordinary).toBeEnabled();
    await userEvent.click(ordinary);
    expect(screen.getByText("Request")).toBeVisible();
    expect(screen.getByText("Lookup result")).toBeVisible();

    view.rerender(
      <Conversation
        messages={convertMessages(
          [
            ...messages,
            {
              id: "delegate-result",
              role: "tool",
              toolCallId: "delegate",
              content: "Research complete",
            },
            {
              id: "parent-answer",
              role: "assistant",
              content: "Final parent reply",
            },
          ],
          false,
          {
            child: {
              start: delegateStart,
              end: {
                type: EventType.SUBAGENT_FINISHED,
                subagentRunId: "child",
              },
            },
          },
        )}
      />,
    );
    expect(task).toHaveAttribute("data-state", "done");
    expect(screen.queryByText("Research complete")).not.toBeInTheDocument();
    expect(within(task).getByRole("button")).toBeDisabled();
    expect(screen.queryByText("Child-only reply")).not.toBeInTheDocument();
    expect(screen.getByText("Final parent reply")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Copy message" }),
    ).toHaveLength(1);
  },
);

test.each([
  { childFailed: true, proxyFailed: false },
  { childFailed: false, proxyFailed: true },
])(
  "shows a failed TaskCard for child or proxy failures: %j",
  ({ childFailed, proxyFailed }) => {
    const end: Subagent["end"] = childFailed
      ? {
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: "child",
          message: "Child connection lost",
        }
      : { type: EventType.SUBAGENT_FINISHED, subagentRunId: "child" };
    render(
      <Conversation
        messages={convertMessages(
          [
            ...delegateMessages,
            {
              id: "delegate-result",
              role: "tool",
              toolCallId: "delegate",
              content: proxyFailed ? "Proxy connection lost" : "Proxy returned",
              ...(proxyFailed ? { error: "Proxy connection lost" } : {}),
            },
          ],
          false,
          { child: { start: delegateStart, end } },
        )}
      />,
    );
    const task = screen.getByRole("group", {
      name: "Subagent: Research assistant",
    });
    expect(task).toHaveAttribute("data-slot", "task-card");
    expect(task).toHaveAttribute("data-state", "failed");
    expect(
      screen.queryByText(
        childFailed ? "Child connection lost" : "Proxy connection lost",
      ),
    ).not.toBeInTheDocument();
    expect(within(task).getByRole("button")).toBeDisabled();
  },
);

test("branches only final parent replies, using canonical Message IDs instead of projected Part IDs", async () => {
  const messages: Message[] = [
    { id: "user", role: "user", content: "Question" },
    {
      id: "intermediate",
      role: "assistant",
      content: "Working",
      metadata: { openchart: { messageId: "msg_step" } },
    },
    {
      id: "prt_reply",
      role: "assistant",
      content: "Answer",
      metadata: { openchart: { messageId: "msg_reply" } },
    },
  ];
  const view = render(<Conversation messages={convertMessages(messages)} />);
  expect(
    screen.getAllByRole("button", { name: "Branch in new chat" }),
  ).toHaveLength(1);
  await userEvent.click(
    screen.getByRole("button", { name: "Branch in new chat" }),
  );
  expect(forkSession).toHaveBeenCalledWith("msg_reply");
  view.rerender(
    <Conversation messages={convertMessages(messages, true)} running />,
  );
  expect(
    screen.queryByRole("button", { name: "Branch in new chat" }),
  ).not.toBeInTheDocument();
});
