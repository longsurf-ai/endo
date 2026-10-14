// Purpose: Verifies native tool conversion and action placement on finished replies.

import { toAssistantUiMessage } from "@openchart/app/features/agent/ag-ui/react/assistant-ui-message-metadata";
import { EventSchemas, EventType, type Message } from "@ag-ui/core";
import { fromAgUiMessages } from "@assistant-ui/react-ag-ui";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { describe, expect, test } from "vitest";

import { convertMessages } from "@openchart/app/features/agent/ag-ui/react/assistant-ui-messages";
import { addMessageMetadata } from "@openchart/app/features/agent/ag-ui/react/assistant-ui-message-metadata";
import type { Subagent } from "@openchart/app/lib/agent/session-store";

test("renders the backend Dig In marker once as a quote tile without consuming equal question text", () => {
  const message: Message = {
    id: "first-dig-in-question",
    role: "user",
    content: "Selected passage",
    metadata: {
      parts: [
        {
          type: "context",
          context: {
            kind: "dig_in",
            quoteText: "Selected passage",
            parentSessionId: "parent",
          },
        },
        { type: "text", text: "Selected passage" },
      ],
    },
  };
  expect(convertMessages([message])[0]?.content).toEqual([
    { type: "data", name: "dig_in", data: "Selected passage" },
    { type: "text", text: "Selected passage" },
  ]);
});

test("renders workflows and quotes without consuming equal user text or other context", () => {
  const workflow = {
    type: "workflow",
    workflow: "default:workflows/best-of-n.workflow.ts",
    args: { n: 3, question: "Same text" },
  };
  const message: Message = {
    id: "user",
    role: "user",
    content: "Same text\nReport\nFollow-up",
    metadata: {
      parts: [
        workflow,
        { type: "text", text: "Same text" },
        {
          type: "context",
          context: { kind: "document", title: "Report", text: "Full report" },
        },
        { type: "context", context: { kind: "quote", text: "Same text" } },
        {
          type: "file",
          mime: "image/png",
          url: "https://example.test/chart.png",
        },
        { type: "context", context: { kind: "plugin", content: "Hidden" } },
        { type: "context", context: { kind: "quote", text: "Second quote" } },
        { type: "text", text: "Follow-up" },
      ],
    },
  };
  const original = structuredClone(message);
  const [converted] = convertMessages([message]);
  expect(converted?.content).toEqual([
    { type: "data", name: "workflow", data: workflow },
    { type: "data", name: "quote", data: "Same text" },
    { type: "data", name: "quote", data: "Second quote" },
    { type: "text", text: "Same text\nReport\nFollow-up" },
  ]);
  expect(converted?.attachments).toEqual([
    {
      id: "0",
      type: "image",
      name: "image",
      contentType: "image/png",
      status: { type: "complete" },
      content: [{ type: "image", image: "https://example.test/chart.png" }],
    },
  ]);
  expect(message).toEqual(original);
});

test("does not interpret an ordinary Markdown blockquote as structured quote context", () => {
  expect(
    convertMessages([
      { id: "user", role: "user", content: "> Authored text\n\nQuestion" },
    ])[0]?.content,
  ).toEqual("> Authored text\n\nQuestion");
});

test("rejects malformed quote metadata instead of silently losing quoted context", () => {
  expect(() =>
    convertMessages([
      {
        id: "user",
        role: "user",
        content: "Question",
        metadata: { parts: [{ type: "context", context: { kind: "quote" } }] },
      },
    ]),
  ).toThrow();
});

test("groups native nested attribution under the spawning tools and preserves failed child content", () => {
  const tool = (id: string, subagentRunId?: string): Message => ({
    id,
    role: "assistant",
    subagentRunId,
    toolCalls: [
      { id, type: "function", function: { name: "Agent", arguments: "{}" } },
    ],
  });
  const messages: Message[] = [
    tool("alpha"),
    tool("beta"),
    {
      id: "alpha-text",
      role: "assistant",
      content: "Alpha answer",
      subagentRunId: "alpha",
    },
    tool("nested", "alpha"),
    {
      id: "nested-text",
      role: "assistant",
      content: "Nested answer",
      subagentRunId: "nested",
    },
    {
      id: "beta-text",
      role: "assistant",
      content: "Beta partial",
      subagentRunId: "beta",
    },
    { id: "root-text", role: "assistant", content: "Parent answer" },
  ];
  const subagents: Record<string, Subagent> = Object.fromEntries(
    ["alpha", "beta", "nested"].map((id) => [
      id,
      {
        start: {
          type: EventType.SUBAGENT_STARTED,
          subagentRunId: id,
          name: id,
          parentToolCallId: id,
          parentMessageId: id,
          ...(id === "nested" ? { parentSubagentRunId: "alpha" } : {}),
        },
        end:
          id === "beta"
            ? {
                type: EventType.SUBAGENT_ERROR,
                subagentRunId: id,
                message: "Interrupted",
              }
            : { type: EventType.SUBAGENT_FINISHED, subagentRunId: id },
      },
    ]),
  );
  const converted = convertMessages(messages, false, subagents);
  expect(converted).toHaveLength(3);
  expect(converted.at(-1)).toMatchObject({
    id: "root-text",
    metadata: { custom: { showActions: true } },
  });
  expect(converted[0]).toMatchObject({
    metadata: {
      custom: {
        toolSubagents: {
          alpha: {
            name: "alpha",
            running: false,
            messages: [
              {
                id: "alpha-text",
                content: [{ type: "text", text: "Alpha answer" }],
                metadata: { custom: { showActions: false } },
              },
              {
                id: "nested",
                metadata: {
                  custom: {
                    toolSubagents: {
                      nested: {
                        messages: [
                          {
                            id: "nested-text",
                            content: [{ type: "text", text: "Nested answer" }],
                          },
                        ],
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  });
  expect(converted[1]).toMatchObject({
    metadata: {
      custom: {
        toolSubagents: {
          beta: {
            error: "Interrupted",
            running: false,
            messages: [{ id: "beta-text" }],
          },
        },
      },
    },
  });
  expect(messages).toHaveLength(7);
});

describe("native AG-UI dependency patches", () => {
  test("validates the upstream result error field including empty failures", () => {
    const event = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "result",
      toolCallId: "call",
      content: "failed",
    };
    for (const error of ["failure", ""])
      expect(EventSchemas.parse({ ...event, error })).toMatchObject({ error });
    for (const error of [null, {}, 4, true])
      expect(EventSchemas.safeParse({ ...event, error }).success).toBe(false);
  });

  test("preserves ordinary native activities as data parts", () => {
    expect(
      fromAgUiMessages([
        {
          id: "activity",
          role: "activity",
          activityType: "openchart.file",
          content: { url: "https://example.com/report.pdf" },
        },
      ]),
    ).toMatchObject([
      {
        id: "activity",
        content: [
          {
            type: "data",
            name: "openchart.file",
            data: { url: "https://example.com/report.pdf" },
          },
        ],
      },
    ]);
  });

  test.each(["failure", ""])(
    "keeps tool error %j and activity together in one card",
    (error) => {
      const messages: Message[] = [
        {
          id: "tool",
          role: "assistant",
          toolCalls: [
            {
              id: "call",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
        {
          id: "result",
          role: "tool",
          toolCallId: "call",
          content: error,
          error,
        },
        {
          id: "activity",
          role: "activity",
          activityType: "openchart.tool",
          content: {
            toolCallId: "call",
            status: "error",
            title: "Search",
            details: { pagesRead: 3 },
            childSessionId: "child",
          },
        },
      ];
      const converted = convertMessages(messages);
      expect(converted).toHaveLength(1);
      expect(converted[0]).toMatchObject({
        content: [{ type: "tool-call", toolCallId: "call", isError: true }],
        metadata: {
          custom: {
            toolActivities: {
              call: {
                status: "error",
                details: { pagesRead: 3 },
                childSessionId: "child",
              },
            },
          },
        },
      });
      expect(messages).toHaveLength(3);
    },
  );
});

describe("final reply selection for layout and actions", () => {
  const history: Message[] = [
    { id: "user-1", role: "user", content: "First question" },
    { id: "progress-1", role: "assistant", content: "Checking the data" },
    { id: "answer-1", role: "assistant", content: "First answer" },
    { id: "user-2", role: "user", content: "Second question" },
    {
      id: "progress-2",
      role: "assistant",
      content: "I will check another source",
    },
    {
      id: "tool",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "search", arguments: "{}" },
        },
      ],
    },
    { id: "result", role: "tool", toolCallId: "call", content: "data" },
    { id: "reasoning", role: "reasoning", content: "Checking the result" },
    {
      id: "activity",
      role: "activity",
      activityType: "openchart.file",
      content: { name: "report" },
    },
    { id: "answer-2", role: "assistant", content: "Second answer" },
    { id: "empty", role: "assistant", content: "  " },
  ];

  test.each([
    { running: true, expected: ["answer-1"] },
    { running: false, expected: ["answer-1", "answer-2"] },
  ])(
    "shows only finished reply actions while running=$running",
    ({ running, expected }) => {
      const before = structuredClone(history);
      const converted = convertMessages(history, running);
      expect(
        converted
          .filter((message) => message.metadata?.custom?.showActions)
          .map((message) => message.id),
      ).toEqual(expected);
      expect(
        converted
          .filter(
            (message) =>
              message.metadata?.custom?.finalReplyStartIndex !== undefined,
          )
          .map((message) => [
            message.id,
            message.metadata?.custom?.finalReplyStartIndex,
          ]),
      ).toEqual(expected.map((id) => [id, 0]));
      expect(history).toEqual(before);
    },
  );

  test("keeps earlier reply actions when a new turn has no text yet", () => {
    const messages: Message[] = [
      ...history,
      { id: "user-3", role: "user", content: "Third question" },
    ];
    expect(
      convertMessages(messages, true)
        .filter((message) => message.metadata?.custom?.showActions)
        .map((message) => message.id),
    ).toEqual(["answer-1", "answer-2"]);
  });
});

test.each<Message>([
  { id: "reasoning", role: "reasoning", content: "Still checking" },
  {
    id: "tool",
    role: "assistant",
    toolCalls: [
      {
        id: "call",
        type: "function",
        function: { name: "search", arguments: "{}" },
      },
    ],
  },
  {
    id: "activity",
    role: "activity",
    activityType: "openchart.file",
    content: { name: "report" },
  },
])("keeps commentary inside work when followed by $role", (continuation) => {
  const messages: Message[] = [
    { id: "user", role: "user", content: "Research this" },
    { id: "commentary", role: "assistant", content: "Let me check" },
    continuation,
  ];
  for (const message of convertMessages(messages).filter(
    (message) => message.role === "assistant",
  )) {
    expect(message.metadata?.custom).toMatchObject({
      finalReplyStartIndex: undefined,
      showActions: false,
    });
  }
  const converted = convertMessages([
    ...messages,
    { id: "answer", role: "assistant", content: "The answer" },
  ]);
  expect(converted.at(-1)?.metadata?.custom).toMatchObject({
    finalReplyStartIndex: 0,
    showActions: true,
  });
});

test("selects the final text segment using runtime part positions without mutating the input", () => {
  const messages: ThreadMessageLike[] = [
    {
      id: "reply",
      role: "assistant",
      content: [
        { type: "text", text: "  " },
        { type: "text", text: "Let me check" },
        { type: "reasoning", text: "Checking" },
        { type: "reasoning", text: "  " },
        { type: "text", text: "The answer" },
        { type: "text", text: "More details" },
        { type: "reasoning", text: "" },
      ],
    },
  ];
  const original = structuredClone(messages);
  expect(
    addMessageMetadata(messages, [], false, true, {})[0]?.metadata?.custom,
  ).toMatchObject({
    finalReplyStartIndex: 2,
    showActions: true,
  });
  expect(
    addMessageMetadata(messages, [], true, true, {})[0]?.metadata?.custom,
  ).toMatchObject({
    finalReplyStartIndex: undefined,
    showActions: false,
  });
  expect(messages).toEqual(original);
});

test("selects the reply after attaching late tool Activity metadata", () => {
  const converted = convertMessages([
    {
      id: "tool",
      role: "assistant",
      toolCalls: [
        {
          id: "call",
          type: "function",
          function: { name: "search", arguments: "{}" },
        },
      ],
    },
    { id: "result", role: "tool", toolCallId: "call", content: "Evidence" },
    { id: "answer", role: "assistant", content: "The answer" },
    {
      id: "activity",
      role: "activity",
      activityType: "openchart.tool",
      content: {
        toolCallId: "call",
        status: "completed",
        title: "Search",
      },
    },
  ]);
  expect(converted).toHaveLength(2);
  expect(converted[0]?.metadata?.custom?.toolActivities).toMatchObject({
    call: { title: "Search" },
  });
  expect(converted[1]?.metadata?.custom).toMatchObject({
    finalReplyStartIndex: 0,
    showActions: true,
  });
});

test("uses native message time for display rather than the time history was opened", () => {
  expect(
    convertMessages([
      {
        id: "user",
        role: "user",
        content: "hello",
        metadata: { openchart: { createdAt: 1234 } },
      },
    ]).map(toAssistantUiMessage)[0],
  ).toMatchObject({
    createdAt: new Date(1234),
    metadata: { custom: { sourceCreatedAt: 1234 } },
  });
});

test.each([12345, null, undefined])(
  "maps completion by canonical message ID across projected parts (%s)",
  (completedAt) => {
    const messages: Message[] = [
      {
        id: "reasoning-part",
        role: "reasoning",
        content: "Checking sources",
        metadata: { openchart: { messageId: "native", createdAt: 1000 } },
      },
      {
        id: "text-part",
        role: "assistant",
        content: "The answer",
        metadata: { openchart: { messageId: "native", createdAt: 1000 } },
      },
    ];
    const original = structuredClone(messages);
    const converted = convertMessages(
      messages,
      false,
      {},
      {
        native: { completedAt, workspaceRoot: "/original-workspace" },
        "text-part": { completedAt: 99999 },
      },
    );
    expect(converted).toHaveLength(2);
    for (const message of converted) {
      expect(message.metadata?.custom).toMatchObject({
        sourceCreatedAt: 1000,
        sourceCompletedAt: completedAt,
        sourceMessageId: "native",
        workspaceRoot: "/original-workspace",
      });
    }
    expect(messages).toEqual(original);
  },
);

test("reads tool call provenance from the call, where the projection and TOOL_CALL_START put it", () => {
  const source = { messageId: "native", partId: "tool-part", createdAt: 1000 };
  const [message] = convertMessages(
    [
      {
        id: "tool-part",
        role: "assistant",
        toolCalls: [
          {
            id: "call",
            type: "function",
            function: { name: "workflow", arguments: "{}" },
            metadata: { openchart: source },
          },
        ],
      },
      {
        id: "tool-part:result",
        role: "tool",
        toolCallId: "call",
        content: "{}",
        metadata: { openchart: source },
      },
    ],
    false,
    {},
    { native: { completedAt: 5000 } },
  );
  expect(message?.metadata?.custom).toMatchObject({
    sourceCreatedAt: 1000,
    sourceCompletedAt: 5000,
    sourceMessageId: "native",
  });
});

test.each([false, true])(
  "keeps action placement after mapping native timestamps (running: %s)",
  (running) => {
    const [message] = convertMessages(
      [
        {
          id: "reply",
          role: "assistant",
          content: "Finished answer",
          metadata: { openchart: { createdAt: 5678 } },
        },
      ],
      running,
    );
    expect(toAssistantUiMessage(message!)).toMatchObject({
      id: "reply",
      createdAt: new Date(5678),
      metadata: { custom: { sourceCreatedAt: 5678, showActions: !running } },
    });
  },
);
