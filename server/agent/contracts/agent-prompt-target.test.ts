// Purpose: Locks the strict stored prompt target shared by Schedules and Triggers.

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { AgentPromptTarget } from "./agent-prompt-target";
import { AgentPromptInput } from "./agent-prompt-input";

const target = {
  kind: "agent_prompt",
  prompt: {
    agent: "analyst",
    model: { providerID: "codex", modelID: "tier1" },
    parts: [{ type: "text", text: "Review the alert." }],
  },
};
const decode = Schema.decodeUnknownSync(AgentPromptTarget);
const text = { type: "text", text: "Review the alert." } as const;
const quote = {
  type: "context",
  context: { kind: "quote", text: "AAPL crossed the ray." },
} as const;
const workflow = {
  type: "workflow",
  workflow: "default:workflows/multi-turn-debate.workflow.ts",
  args: { round: 3, topic: "Should I buy AAPL?" },
} as const;
const compaction = { type: "compaction", auto: false } as const;
const image = {
  type: "file",
  mime: "image/png",
  filename: "chart.png",
  url: "https://example.com/chart.png",
} as const;

describe("AgentPromptTarget", () => {
  it("round-trips a prompt with and without a binding", () => {
    expect(decode(target)).toEqual(target);
    const bound = { ...target, binding: { key: "alert:review" } };
    expect(decode(bound)).toEqual(bound);
  });

  it.each([
    { parts: [text] },
    { parts: [workflow] },
    { parts: [compaction] },
    { parts: [quote] },
    { parts: [image] },
    { parts: [quote, image] },
    { parts: [quote, text, image, image] },
    { parts: [quote, workflow, image] },
    { parts: [quote, compaction, image] },
  ])("preserves composer part order: $parts", ({ parts }) => {
    const value = { ...target, prompt: { ...target.prompt, parts } };
    expect(decode(value)).toEqual(value);
  });

  it.each([
    { name: "text followed by workflow", parts: [text, workflow] },
    { name: "workflow followed by text", parts: [workflow, text] },
    { name: "text with compaction", parts: [text, compaction] },
    { name: "two commands", parts: [workflow, compaction] },
    { name: "multiple text parts", parts: [text, text] },
    { name: "multiple quotes", parts: [quote, quote, text] },
    { name: "quote after text", parts: [text, quote] },
    { name: "text after images", parts: [image, text] },
    { name: "workflow after images", parts: [image, workflow] },
  ])("rejects $name with actionable feedback", ({ parts }) => {
    expect(() =>
      decode({ ...target, prompt: { ...target.prompt, parts } }),
    ).toThrow(
      "Saved prompts require an optional quote, then text or one command, then images.",
    );
  });

  it.each([
    { name: "non-image file", parts: [{ ...image, mime: "application/pdf" }] },
    { name: "unnamed image", parts: [{ ...image, filename: undefined }] },
    { name: "empty text", parts: [{ type: "text", text: "" }] },
    { name: "raw command", parts: [{ type: "text", text: "/compact" }] },
    {
      name: "command chip",
      parts: [{ type: "text", text: ":command[/compact]{name=compact}" }],
    },
    { name: "part identity", parts: [{ ...text, id: "prt_original" }] },
    { name: "synthetic text", parts: [{ ...text, synthetic: true }] },
    { name: "text metadata", parts: [{ ...text, metadata: {} }] },
    {
      name: "execution context",
      parts: [
        {
          type: "context",
          context: { kind: "document", title: "doc", text: "context" },
        },
      ],
    },
  ])("rejects composer-unsupported fields: $name", ({ parts }) => {
    expect(() =>
      decode({ ...target, prompt: { ...target.prompt, parts } }),
    ).toThrow();
  });

  it("keeps accompanying text valid for execution inputs", () => {
    const prompt = { ...target.prompt, parts: [workflow, text] };
    expect(Schema.decodeUnknownSync(AgentPromptInput)(prompt)).toEqual(prompt);
  });

  it.each([
    ["another kind", { ...target, kind: "notification" }],
    ["a missing prompt", { kind: "agent_prompt" }],
    [
      "an invalid prompt",
      { ...target, prompt: { ...target.prompt, parts: [] } },
    ],
    ["an empty binding key", { ...target, binding: { key: "" } }],
    ["an extra binding field", { ...target, binding: { key: "k", id: 1 } }],
    ["an extra field", { ...target, sessionId: "ses_1" }],
  ])("rejects %s", (_, invalid) => {
    expect(() => decode(invalid)).toThrow();
  });
});
