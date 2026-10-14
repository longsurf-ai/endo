// Purpose: Locks one context shape across prompt input, persistence, and consumers.

import { Schema, Result } from "effect";

import { describe, expect, it } from "vitest";
import { AgentPromptPartInput } from "@openchart/server/agent/contracts/agent-prompt-input";
import {
  ContextPart,
  Part,
  PluginContext,
  type PartContext,
} from "@openchart/server/agent/contracts/part";

const identity = { id: "prt_context", messageID: "msg_1" };
const contexts: PartContext[] = [
  { kind: "resource", resource: "chart", id: "chr_1", scope: "current" },
  { kind: "resource", resource: "workspace", id: "wsp_1", scope: "attached" },
  { kind: "document", title: "Notes", text: "The attached source text." },
  {
    kind: "document",
    title: "News",
    text: "Analyze the attached evidence.",
    evidence: [
      {
        source: {
          kind: "web_search_result",
          title: "Source",
          url: "https://example.com/article",
          hostname: "example.com",
        },
        blocks: [{ kind: "excerpt", text: "Exact source material." }],
      },
    ],
  },
  {
    kind: "session",
    sessionId: "ses_analysis",
    throughCreatedAt: "2026-09-07T12:00:00.000Z",
  },
  { kind: "quote", text: "" },
  {
    kind: "quote",
    text: " Quoted source text\n**unchanged** ",
  },
  { kind: "dig_in", quoteText: " Dig deeper\n**this selection** " },
  { kind: "dig_in", quoteText: "" },
  Schema.decodeUnknownSync(PluginContext)({
    kind: "plugin",
    pluginId: "research",
    hook: "run.before",
    content: " Caller-provided context\n**unchanged** ",
  }),
];

describe("context Parts", () => {
  it.each([
    { type: "quote", text: "Quoted text" },
    { type: "dig_in_context", quoteText: "Selected text" },
    { type: "context", context: { kind: "quote" } },
    { type: "context", context: { kind: "dig_in" } },
    { type: "context", context: { kind: "dig_in", text: "Wrong field" } },
    { type: "context", context: { kind: "claim", quoteText: "Obsolete kind" } },
    {
      type: "plugin_context",
      pluginId: "research",
      hook: "run.before",
      content: "Obsolete top-level variant",
    },
    {
      type: "context",
      context: { kind: "plugin", content: "Missing identity" },
    },
    ...[
      { contributionId: "selection" },
      { hook: "" },
      { hook: "run.before", contributionId: "obsolete" },
    ].map((fields) => ({
      type: "context",
      context: {
        kind: "plugin",
        pluginId: "research",
        content: "Context",
        ...fields,
      },
    })),
    {
      type: "context",
      context: {
        kind: "quote",
        text: "Retired source",
        source: { partId: "prt_source", startOffset: 0, endOffset: 2 },
      },
    },
  ])("rejects removed Part types and incomplete context: %j", (input) => {
    expect(() =>
      Schema.decodeUnknownSync(AgentPromptPartInput)(input),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Part)({ ...identity, ...input }),
    ).toThrow();
  });

  it.each(contexts)(
    "preserves $kind facts in prompt and transcript shapes",
    (context) => {
      const input = { type: "context", context };
      expect(Schema.decodeUnknownSync(AgentPromptPartInput)(input)).toEqual(
        input,
      );
      expect(Schema.decodeUnknownSync(Part)({ ...identity, ...input })).toEqual(
        {
          ...identity,
          ...input,
        },
      );
    },
  );

  it("accepts new Resource names without an Agent-owned resource whitelist", () => {
    const context = {
      kind: "resource",
      resource: "new_resource",
      id: "new_1",
      scope: "attached",
    };
    expect(
      Schema.decodeUnknownSync(AgentPromptPartInput)({
        type: "context",
        context,
      }),
    ).toEqual({
      type: "context",
      context,
    });
  });

  it("rejects presentation sidecars and legacy pointer fields at both boundaries", () => {
    const context = contexts[0]!;
    for (const input of [
      { type: "context", model: context },
      { type: "context", context, model: context },
      { type: "context", context, display: { kind: "resource_tree" } },
      { type: "context", context: { ...context, path: "/charts/chr_1" } },
      {
        type: "context",
        context: { ...context, snapshot: { label: "Chart" } },
      },
      { type: "context", context: { ...context, kind: "resource_reference" } },
    ]) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(AgentPromptPartInput)(input),
        ),
      ).toBe(false);
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(ContextPart)({ ...identity, ...input }),
        ),
      ).toBe(false);
    }
  });

  it("requires resource identity, explicit scope, and a historical session cutoff", () => {
    for (const context of [
      { kind: "resource", resource: "", id: "chr_1", scope: "attached" },
      { kind: "resource", resource: "chart", id: "", scope: "attached" },
      { kind: "resource", resource: "chart", id: "chr_1" },
      { kind: "resource", resource: "chart", id: "chr_1", scope: "hidden" },
      { kind: "session", sessionId: "ses_analysis" },
      {
        kind: "session",
        sessionId: "ses_analysis",
        throughCreatedAt: "latest",
      },
      {
        kind: "session",
        sessionId: "",
        throughCreatedAt: "2026-09-07T12:00:00.000Z",
      },
      { kind: "document", title: "News", text: "Analyze", evidence: [] },
    ]) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(AgentPromptPartInput)({
            type: "context",
            context,
          }),
        ),
      ).toBe(false);
    }
  });
});
