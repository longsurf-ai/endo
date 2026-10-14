// Purpose: Locks transcript reconstruction and column-free SQL payloads for every variant.

import { Schema } from "effect";

import { describe, expect, it } from "vitest";
import { MessageInfo } from "@openchart/server/agent/contracts/message";
import * as Part from "@openchart/server/agent/contracts/part";
import * as MessageData from "./data";

const base = {
  id: "prt_original",
  messageID: "msg_original",
};
const tokens = {
  input: 1,
  output: 2,
  reasoning: 3,
  cache: { read: 4, write: 5 },
};
const parts = [
  {
    type: "text",
    text: "hello",
    synthetic: true,
    time: { start: 1, end: 2 },
    metadata: { provider: { itemId: "item_1" } },
  },
  {
    type: "subtask",
    prompt: "research",
    description: "research task",
    agent: "analyst",
    model: { providerID: "openai", modelID: "gpt-5" },
    command: "research",
  },
  {
    type: "workflow",
    workflow: "workspace:review.workflow.ts",
    args: { nodeIds: ["node_1"] },
  },
  {
    type: "reasoning",
    text: "trace",
    time: { start: 1 },
    metadata: { openai: { encryptedContent: "opaque" } },
  },
  {
    type: "file",
    mime: "image/png",
    filename: "chart.png",
    url: "https://example.com/chart.png",
    source: {
      type: "file",
      path: "/chart.png",
      text: { value: "chart", start: 0, end: 5 },
    },
  },
  {
    type: "context",
    context: {
      kind: "quote",
      text: "claim",
    },
  },
  {
    type: "context",
    context: {
      kind: "session",
      sessionId: "ses_source",
      throughCreatedAt: "2026-09-06T00:00:00.000Z",
    },
  },
  {
    type: "plugin_input",
    input: { type: "alert_trigger", eventId: "event_1" },
  },
  {
    type: "context",
    context: {
      kind: "plugin",
      pluginId: "chart-context",
      hook: "run.before",
      content: "Plugin context",
    },
  },
  {
    type: "tool",
    childSessionIds: [],
    callID: "call_1",
    tool: "run_command",
    providerMetadata: { openai: { itemId: "fc_123" } },
    state: {
      status: "completed",
      input: { command: "pwd" },
      output: { type: "json", value: { cwd: "/tmp" } },
      title: "Working directory",
      metadata: {},
      time: { start: 1, end: 2, compacted: 3 },
      attachments: [
        {
          ...base,
          type: "file",
          mime: "text/plain",
          url: "file:///tmp/result.txt",
        },
      ],
    },
  },
  {
    type: "evidence",
    evidenceID: "evd_0123456789ABCD",
    sourcePartID: "prt_source",
    capturedAt: 1,
    contentHash: "a".repeat(64),
    source: {
      kind: "web_search_result",
      title: "Source",
      url: "https://example.com/",
      hostname: "example.com",
    },
    blocks: [
      { id: "b0", kind: "snippet", text: "exact evidence", truncated: false },
    ],
  },
  { type: "step-start", snapshot: "before" },
  { type: "step-finish", reason: "stop", snapshot: "after", cost: 0.2, tokens },
  {
    type: "agent",
    name: "analyst",
    source: { value: "@analyst", start: 0, end: 8 },
  },
  { type: "context", context: { kind: "dig_in", quoteText: "claim" } },
  { type: "compaction", auto: true },
];

describe("complete transcript schema", () => {
  it("rejects obsolete ignored flags in stored text", () => {
    expect(() =>
      Schema.decodeUnknownSync(MessageData.PartData)({
        type: "text",
        text: "Content",
        ignored: true,
      }),
    ).toThrow();
  });

  it.each([
    { type: "quote", text: "Quoted text" },
    { type: "dig_in_context", quoteText: "Selected text" },
  ])("rejects the removed $type Part at both boundaries", (part) => {
    expect(() =>
      Schema.decodeUnknownSync(Part.Part)({ ...base, ...part }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MessageData.PartData)(part),
    ).toThrow();
  });

  it("rejects obsolete patch Parts in transcripts and SQL payloads", () => {
    const patch = { type: "patch", hash: "hash", files: ["example.ts"] };
    expect(() =>
      Schema.decodeUnknownSync(Part.Part)({ ...base, ...patch }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MessageData.PartData)(patch),
    ).toThrow();
  });

  it.each(parts)(
    "round-trips $type content with authoritative SQL columns",
    (part) => {
      const complete = Schema.decodeUnknownSync(Part.Part)({
        ...base,
        ...part,
      });
      expect(complete).toEqual({ ...base, ...part });
      const data = Schema.decodeUnknownSync(MessageData.PartData)(part);
      expect(data).toEqual(part);
      expect(Schema.decodeUnknownSync(Part.Part)({ ...data, ...base })).toEqual(
        complete,
      );
      expect(() =>
        Schema.decodeUnknownSync(MessageData.PartData)(complete),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(MessageData.PartData)({
          ...part,
          sessionID: "ses_redundant",
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(MessageData.PartData)({
          ...part,
          origin: "inherited",
        }),
      ).toThrow();
    },
  );

  it("covers every persisted variant", () => {
    expect(
      Part.Part.members.map((part) => part.fields.type.schema.literal),
    ).toEqual([...new Set(parts.map((part) => part.type))]);
    expect(
      MessageData.PartData.members.map(
        (part) => part.fields.type.schema.literal,
      ),
    ).toEqual([...new Set(parts.map((part) => part.type))]);
  });

  it("preserves both message roles and inherited content times", () => {
    const user = {
      role: "user",
      time: { created: 100 },
      agent: "analyst",
      model: {
        providerID: "openai",
        modelID: "gpt-5",
        selectedVariant: "high",
      },
    };
    const assistant = {
      role: "assistant",
      time: { created: 101, completed: 102 },
      triggeringUserMessageID: "msg_user",
      providerID: "openai",
      modelID: "gpt-5",
      agent: "analyst",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0.2,
      tokens,
      summary: true,
      finish: "stop",
      request: {
        instructions: "instructions",
        system: ["system"],
        tools: [
          { id: "tool", description: "tool", inputSchema: { type: "object" } },
        ],
        toolChoice: "auto",
      },
    };
    for (const info of [user, assistant]) {
      const { role, ...payload } = info;
      const columns = {
        id: "msg_fork",
        sessionID: "ses_fork",
        role,
      };
      const data = Schema.decodeUnknownSync(MessageData.InfoData)(payload);
      const complete = Schema.decodeUnknownSync(MessageInfo)({
        ...data,
        ...columns,
      });
      expect(complete).toEqual({ ...info, ...columns });
      expect(() =>
        Schema.decodeUnknownSync(MessageData.InfoData)(complete),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(MessageData.InfoData)({
          ...payload,
          origin: "original",
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(MessageData.InfoData)({
          ...payload,
          mode: "analyst",
        }),
      ).toThrow();
    }
  });
});
