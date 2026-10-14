// Purpose: Locks the canonical AgentPromptInput execution-snapshot invariant.

import { Schema, Result } from "effect";
import {
  CODEX,
  MODEL_PROVIDER_IDS,
  MODEL_TIER_IDS,
} from "@openchart/models/model-tiers";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AgentPromptInput,
  AgentPromptModel,
  AgentPromptPartInput,
} from "./agent-prompt-input";

const model = { providerID: "codex" as const, modelID: "tier1" as const };

describe("AgentPromptInput", () => {
  it("accepts manual compaction with accompanying text and rejects automatic compaction", () => {
    const decode = (parts: unknown[]) =>
      Schema.decodeUnknownSync(AgentPromptInput)({
        agent: "analyst",
        model,
        parts,
      });
    expect(decode([{ type: "compaction", auto: false }]).parts).toEqual([
      { type: "compaction", auto: false },
    ]);
    expect(() => decode([{ type: "compaction", auto: true }])).toThrow();
    for (const extra of [
      { type: "text", text: "Conversation context" },
      { type: "text", text: "Current view", synthetic: true },
    ]) {
      const parts = [{ type: "compaction", auto: false }, extra];
      expect(decode(parts).parts).toEqual(parts);
    }
  });
  it.each(
    MODEL_PROVIDER_IDS.flatMap((providerID) =>
      MODEL_TIER_IDS.map((modelID) => ({ providerID, modelID })),
    ),
  )(
    "preserves the supported provider and tier $providerID/$modelID",
    (model) => {
      const input = {
        agent: "analyst",
        model,
        parts: [{ type: "text", text: "Analyze" }],
      };
      expect(Schema.decodeUnknownSync(AgentPromptInput)(input)).toEqual(input);
    },
  );

  it.each([
    { providerID: "unknown", modelID: "tier1" },
    { providerID: "codxe", modelID: "tier1" },
    { providerID: "openai-compatible", modelID: "tier1" },
    { providerID: CODEX, modelID: "tier0" },
    { providerID: CODEX, modelID: "tier6" },
    { providerID: CODEX, modelID: "gpt-6-astra" },
    { providerID: CODEX, modelID: "" },
  ])("rejects invalid model selection $providerID/$modelID", (model) => {
    expect(() =>
      Schema.decodeUnknownSync(AgentPromptInput)({
        agent: "analyst",
        model,
        parts: [{ type: "text", text: "Analyze" }],
      }),
    ).toThrow();
  });

  it("derives closed provider and tier types from the prompt schema", () => {
    expectTypeOf<AgentPromptModel["providerID"]>().toEqualTypeOf<
      "codex" | "claude-code" | "antigravity"
    >();
    expectTypeOf<AgentPromptModel["modelID"]>().toEqualTypeOf<
      "tier1" | "tier2" | "tier3" | "tier4" | "tier5"
    >();
  });

  it("keeps caller-supplied Part IDs optional in the derived TypeScript type", () => {
    expectTypeOf<AgentPromptPartInput["id"]>().toEqualTypeOf<
      string | undefined
    >();
  });
  it("accepts an explicit agent, model, and non-empty text parts", () => {
    expect(
      Schema.decodeUnknownSync(AgentPromptInput)({
        agent: "analyst",
        model: { providerID: "codex" as const, modelID: "tier1" as const },
        parts: [{ type: "text", text: "Analyze this." }],
      }),
    ).toEqual({
      agent: "analyst",
      model: { providerID: "codex" as const, modelID: "tier1" as const },
      parts: [{ type: "text", text: "Analyze this." }],
    });
  });

  it("rejects an unresolved model and an empty prompt", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentPromptInput)({
        agent: "analyst",
        model: { providerID: "unknown", modelID: "unknown" },
        parts: [],
      }),
    ).toThrow();
  });

  it("preserves an explicit workspace and rejects an empty or null selection", () => {
    const input = {
      agent: "analyst",
      model,
      parts: [{ type: "text", text: "Analyze this." }],
      workspaceId: "wsp_selected",
    };
    expect(Schema.decodeUnknownSync(AgentPromptInput)(input)).toEqual(input);
    for (const workspaceId of ["", null]) {
      expect(() =>
        Schema.decodeUnknownSync(AgentPromptInput)({ ...input, workspaceId }),
      ).toThrow();
    }
  });

  it("accepts every input variant without requiring materialized identity", () => {
    const parts = [
      { type: "text", text: "Analyze", synthetic: true },
      { type: "file", mime: "image/png", url: "https://example.com/chart.png" },
      { type: "context", context: { kind: "quote", text: "Claim" } },
      {
        type: "context",
        context: {
          kind: "plugin",
          pluginId: "research",
          hook: "run.before",
          content: "Context supplied with the prompt",
        },
      },
      {
        type: "context",
        context: { kind: "document", title: "Document", text: "Source text" },
      },
      {
        type: "plugin_input",
        input: {
          type: "chart_explain",
          drawingId: "drw_1",
          resolution: "5m",
          session: "extended",
          adjustment: "split",
        },
      },
      { type: "context", context: { kind: "dig_in", quoteText: "Claim" } },
      { type: "agent", name: "analyst" },
      {
        type: "subtask",
        prompt: "Research",
        description: "Task",
        agent: "analyst",
      },
      {
        type: "workflow",
        id: "prt_workflow",
        workflow: "workspace:workflow.workflow.ts",
        args: {},
      },
      { type: "compaction", auto: false },
    ];
    expect(
      AgentPromptPartInput.members.map(
        (part) => part.fields.type.schema.literal,
      ),
    ).toEqual([...new Set(parts.map((part) => part.type))]);
    for (const part of parts) {
      expect(
        Schema.decodeUnknownSync(AgentPromptInput)({
          agent: "analyst",
          model,
          parts: [part],
        }),
      ).toEqual({ agent: "analyst", model, parts: [part] });
    }
  });

  it("rejects mixed control intent and runtime-only part variants", () => {
    const workflow = {
      type: "workflow",
      workflow: "workspace:workflow.workflow.ts",
      args: {},
    };
    for (const parts of [
      [workflow, workflow],
      [
        workflow,
        {
          type: "subtask",
          prompt: "Research",
          description: "Task",
          agent: "analyst",
        },
      ],
      [{ type: "reasoning", text: "trace", time: { start: 1 } }],
    ])
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(AgentPromptInput)({
            agent: "analyst",
            model,
            parts,
          }),
        ),
      ).toBe(false);
    for (const identity of ["sessionID", "messageID", "runID"]) {
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(AgentPromptInput)({
            agent: "analyst",
            model,
            parts: [{ type: "text", text: "hello" }],
            [identity]: "external",
          }),
        ),
      ).toBe(false);
    }
  });
});
