// Purpose: Verify OpenCode tool fidelity, usage semantics and terminal stream behavior.
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { TurnTranslator } from "./translate";
import { convertPrompt } from "./history";

describe("OpenCode stream translation", () => {
  it("uses final native arguments rather than the empty pending placeholder", () => {
    const parts: LanguageModelV4StreamPart[] = [];
    const turn = new TurnTranslator((part) => parts.push(part));
    turn.update({
      sessionUpdate: "tool_call",
      toolCallId: "native",
      name: "read",
      status: "pending",
      rawInput: {},
    });
    turn.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "native",
      status: "in_progress",
      rawInput: { path: "file.txt" },
    });
    turn.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "native",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "token" } }],
    });
    turn.finish({ stopReason: "end_turn" });
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
      input: '{"path":"file.txt"}',
      providerExecuted: true,
    });
    expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(1);
  });

  it("preserves exact host outcomes separately from native proxy output", () => {
    const parts: LanguageModelV4StreamPart[] = [];
    const turn = new TurnTranslator((part) => parts.push(part));
    const outcome = { privateState: { version: 7 }, visible: "ok" };
    turn.hostStarted("host", "echo", { token: "test" });
    turn.hostFinished("host", "echo", outcome, false);
    turn.finish({ stopReason: "end_turn" });
    const result = parts.find((part) => part.type === "tool-result");
    expect(result).toMatchObject({
      result: outcome,
      providerMetadata: { openchart: { toolExecution: "provider-mcp" } },
    });
    if (result?.type === "tool-result") expect(result.result).toBe(outcome);
  });

  it("counts cache and reasoning according to pinned OpenCode usage", () => {
    const parts: LanguageModelV4StreamPart[] = [];
    const turn = new TurnTranslator((part) => parts.push(part));
    turn.finish({
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cachedReadTokens: 30,
        cachedWriteTokens: 5,
        thoughtTokens: 7,
      },
    });
    expect(parts.at(-1)).toMatchObject({
      type: "finish",
      usage: {
        inputTokens: { total: 45, noCache: 10, cacheRead: 30, cacheWrite: 5 },
        outputTokens: { total: 27, text: 20, reasoning: 7 },
      },
    });
  });

  it("fails missing structured output and emits only the submitted value", () => {
    const parts: LanguageModelV4StreamPart[] = [];
    const turn = new TurnTranslator((part) => parts.push(part), true);
    turn.update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Unvalidated prose" },
    });
    expect(() => turn.finish({ stopReason: "end_turn" })).toThrow(
      "structured output",
    );
    turn.finish({ stopReason: "end_turn" }, { result: "valid" });
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      {
        type: "text-delta",
        id: expect.any(String),
        delta: '{"result":"valid"}',
      },
    ]);
  });

  it("fails pending native and host tools exactly once on cancellation", () => {
    const parts: LanguageModelV4StreamPart[] = [];
    const turn = new TurnTranslator((part) => parts.push(part));
    turn.update({
      sessionUpdate: "tool_call",
      toolCallId: "native",
      name: "read",
    });
    turn.hostStarted("host", "echo", {});
    turn.finish({ stopReason: "cancelled" });
    turn.finish({ stopReason: "cancelled" });
    expect(parts.filter((part) => part.type === "tool-result")).toHaveLength(2);
    expect(parts.filter((part) => part.type === "finish")).toHaveLength(1);
  });
});

it("replays complete trailing tool history and keeps leading commands literal", () => {
  const prompt = convertPrompt(
    [
      { role: "system", content: "System instructions" },
      { role: "user", content: [{ type: "text", text: "/compact" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "original",
            toolName: "echo",
            input: { token: "a" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "original",
            toolName: "echo",
            output: {
              type: "json",
              value: { token: "a", details: "complete" },
            },
          },
        ],
      },
    ],
    false,
  );
  expect(prompt.system).toBe("System instructions");
  expect(prompt.text.startsWith("/")).toBe(false);
  expect(prompt.text).toContain('"toolCallId":"original"');
  expect(prompt.text).toContain('"details":"complete"');
  expect(prompt.text).toContain("/compact");
});

it("routes nested child and host output to explicit delegates before sealing their proxies", () => {
  const parts: LanguageModelV4StreamPart[] = [];
  const turn = new TurnTranslator((part) => parts.push(part));
  turn.bindRoot("root");
  turn.child({
    type: "status",
    childSessionId: "child",
    parentSessionId: "root",
    status: "created",
    title: "Investigate",
  });
  turn.child({
    type: "update",
    childSessionId: "child",
    parentSessionId: "root",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Child content" },
    },
  });
  turn.hostStarted("host", "echo", {}, "child");
  turn.hostFinished("host", "echo", { privateChildResult: 7 }, false);
  turn.child({
    type: "status",
    childSessionId: "nested",
    parentSessionId: "child",
    status: "created",
  });
  turn.child({
    type: "status",
    childSessionId: "child",
    parentSessionId: "root",
    status: "completed",
  });
  turn.finish({ stopReason: "end_turn" });
  expect(parts.find((part) => part.type === "text-delta")).toMatchObject({
    providerMetadata: { openchart: { delegateCallId: "opencode-child:child" } },
  });
  expect(
    parts.find(
      (part) => part.type === "tool-result" && part.toolCallId === "host",
    ),
  ).toMatchObject({
    providerMetadata: {
      openchart: {
        delegateCallId: "opencode-child:child",
        toolExecution: "provider-mcp",
      },
    },
  });
  const results = parts
    .filter((part) => part.type === "tool-result")
    .map((part) => part.toolCallId);
  expect(results).toEqual([
    "host",
    "opencode-child:nested",
    "opencode-child:child",
  ]);
});
