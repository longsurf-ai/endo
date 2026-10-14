// Purpose: Verifies summary previews preserve context without replaying payloads.

import type {
  Assistant,
  User,
  WithParts,
} from "@openchart/server/agent/contracts/message";
import type {
  ToolModelOutput,
  ToolPart,
} from "@openchart/server/agent/contracts/part";
import { expect, test } from "vitest";
import { serializeCompactionHistory } from "./compaction-input";

const user: User = {
  id: "user",
  sessionID: "session",
  role: "user",
  agent: "analyst",
  model: { providerID: "codex", modelID: "tier4" },
  time: { created: 1 },
};
const assistant: Assistant = {
  id: "assistant",
  sessionID: "session",
  role: "assistant",
  triggeringUserMessageID: user.id,
  agent: "analyst",
  providerID: "codex",
  modelID: "gpt-6-astra",
  path: { cwd: "/workspace", root: "/workspace" },
  time: { created: 2 },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
};

function tool(output: ToolModelOutput): ToolPart {
  return {
    id: "tool",
    messageID: assistant.id,
    type: "tool",
    tool: "read",
    callID: "call",
    childSessionIds: [],
    providerMetadata: { native: { rawItem: "RAW_PROTOCOL_METADATA" } },
    state: {
      status: "completed",
      input: { path: "/workspace/report" },
      title: "Read report",
      output,
      metadata: { preview: "RAW_UI_METADATA" },
      time: { start: 2, end: 3 },
    },
  };
}

const serializeAll = (messages: readonly WithParts[]) =>
  serializeCompactionHistory(messages, Infinity);

test.each<ToolModelOutput>([
  { type: "text", value: "x".repeat(300_000) },
  { type: "json", value: { result: "x".repeat(300_000) } },
  { type: "content", value: [{ type: "text", text: "x".repeat(300_000) }] },
])("bounds $type tool output without mutating stored history", (output) => {
  const messages = [{ info: assistant, parts: [tool(output)] }];
  const before = structuredClone(messages);
  const text = serializeAll(messages);
  expect(text).toContain(
    '[Assistant tool call]: read({"path":"/workspace/report"})',
  );
  expect(text.split("[Tool result]: ")[1]).toHaveLength(
    2_000 + "\n[truncated]".length,
  );
  expect(text).not.toContain("RAW_PROTOCOL_METADATA");
  expect(text).not.toContain("RAW_UI_METADATA");
  expect(messages).toEqual(before);
});

test("preserves user context and conversation text while describing every attachment", () => {
  const part = tool({
    type: "content",
    value: [
      { type: "text", text: "Visible result" },
      { type: "media", mediaType: "image/png", data: "TOOL_IMAGE_BYTES" },
    ],
  });
  if (part.state.status !== "completed")
    throw new Error("Expected completed tool");
  part.state.attachments = [
    {
      id: "attachment",
      messageID: assistant.id,
      type: "file",
      mime: "application/pdf",
      filename: "result.pdf",
      url: "data:application/pdf;base64,TOOL_FILE_BYTES",
    },
  ];
  const text = serializeAll([
    {
      info: user,
      parts: [
        {
          id: "question",
          messageID: user.id,
          type: "text",
          text: "Which is biggest?",
        },
        {
          id: "quote",
          messageID: user.id,
          type: "context",
          context: { kind: "quote", text: "Keep the comparison grounded" },
        },
        {
          id: "document",
          messageID: user.id,
          type: "context",
          context: {
            kind: "document",
            title: "Notes",
            text: "Important constraint",
          },
        },
        {
          id: "file",
          messageID: user.id,
          type: "file",
          mime: "text/plain",
          filename: "notes.txt",
          url: "data:text/plain,USER_FILE_BYTES",
        },
        { id: "marker", messageID: user.id, type: "compaction", auto: true },
      ],
    },
    {
      info: assistant,
      parts: [
        {
          id: "reason",
          messageID: assistant.id,
          type: "reasoning",
          text: "Compare impact",
          time: { start: 2, end: 3 },
        },
        part,
        {
          id: "reply",
          messageID: assistant.id,
          type: "text",
          text: "The payment integration stands out",
        },
      ],
    },
  ]);
  expect(text).toContain("[User]: The user attached the following quote:");
  expect(text).toContain("Keep the comparison grounded");
  expect(text).toContain("Which is biggest?");
  expect(text).toContain("Important constraint");
  expect(text).toContain("[Attached text/plain: notes.txt]");
  expect(text).toContain("[Assistant reasoning]: Compare impact");
  expect(text).toContain(
    "[Tool result]: Visible result\n[Attached image/png]\n[Attached application/pdf: result.pdf]",
  );
  expect(text).toContain("[Assistant]: The payment integration stands out");
  expect(text).not.toContain("BYTES");
  expect(text).not.toContain("What did we do so far?");
});

test("preserves cleared results, errors and unfinished calls", () => {
  const completed = tool({ type: "text", value: "CLEARED_RESULT" });
  if (completed.state.status !== "completed")
    throw new Error("Expected completed tool");
  completed.state.time.compacted = 4;
  const text = serializeAll([
    {
      info: assistant,
      parts: [
        completed,
        {
          ...tool({ type: "text", value: "" }),
          state: {
            status: "error",
            input: {},
            error: "Access denied",
            time: { start: 2, end: 3 },
          },
        },
        {
          ...tool({ type: "text", value: "" }),
          state: { status: "pending", input: {} },
        },
      ],
    },
  ]);
  expect(text).toContain("[Old tool result content cleared]");
  expect(text).not.toContain("CLEARED_RESULT");
  expect(text).toContain("[Tool error]: Access denied");
  expect(text).toMatch(/\[Assistant tool call\]: read\(\{\}\)$/);
});

test("keeps both ends of history that exceeds the budget", () => {
  const reply = (id: string, text: string) => ({
    info: assistant,
    parts: [{ id, messageID: assistant.id, type: "text" as const, text }],
  });
  const text = serializeCompactionHistory(
    [
      reply("summary", "PRIOR_SUMMARY"),
      reply("old", "x".repeat(10_000)),
      reply("latest", "LATEST_WORK"),
    ],
    1_000,
  );
  expect(text).toMatch(/^\[Assistant\]: PRIOR_SUMMARY/);
  expect(text).toContain("[Middle of conversation truncated]");
  expect(text).toMatch(/\[Assistant\]: LATEST_WORK$/);
  expect(text.length).toBeLessThan(1_100);
});
