// Purpose: Verifies deterministic tool-call repair independently from LLM streaming.

import { describe, expect, test } from "vitest";
import {
  InvalidToolInputError,
  jsonSchema,
  tool,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { repairToolCall } from "./tool-call-repair";

function repairFailure(
  tools: ToolSet,
  toolName: string,
  input = JSON.stringify({ summary: 42 }),
  inputSchema: JSONSchema7 = { type: "object" },
): Parameters<ToolCallRepairFunction<ToolSet>>[0] {
  return {
    instructions: undefined,
    system: undefined,
    messages: [],
    toolCall: {
      type: "tool-call",
      toolCallId: "call_repair",
      toolName,
      input,
    },
    tools,
    inputSchema: async () => inputSchema,
    error: new InvalidToolInputError({
      toolName,
      toolInput: input,
      cause: new Error("summary must be a string"),
    }),
  };
}

describe("tool call repair", () => {
  const tools = {
    watchlist_semantic_result: tool({
      inputSchema: jsonSchema({
        type: "object",
        properties: { summary: { type: "string" } },
      }),
    }),
  };

  test("repairs a case-insensitive tool name match", async () => {
    const failed = repairFailure(tools, "WATCHLIST_SEMANTIC_RESULT");

    expect(await repairToolCall(tools, failed)).toEqual({
      ...failed.toolCall,
      toolName: "watchlist_semantic_result",
    });
  });

  test("unwraps exactly one JSON string layer around object input", async () => {
    const inner = JSON.stringify({ summary: "NVDA result" });
    const failed = repairFailure(
      tools,
      "watchlist_semantic_result",
      JSON.stringify(inner),
    );

    expect(await repairToolCall(tools, failed)).toEqual({
      ...failed.toolCall,
      input: inner,
    });
  });

  test("repairs tool name and double-encoded input together", async () => {
    const inner = JSON.stringify({ summary: "NVDA result" });
    const failed = repairFailure(
      tools,
      "WATCHLIST_SEMANTIC_RESULT",
      JSON.stringify(inner),
    );

    expect(await repairToolCall(tools, failed)).toEqual({
      ...failed.toolCall,
      toolName: "watchlist_semantic_result",
      input: inner,
    });
  });

  test("repairs malformed JSON against the root object schema", async () => {
    const input = '{"summary":"NVDA result"]}';
    const failed = repairFailure(tools, "watchlist_semantic_result", input, {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
    });

    expect(await repairToolCall(tools, failed)).toEqual({
      ...failed.toolCall,
      input: JSON.stringify({ summary: "NVDA result" }),
    });
  });

  test("recursively repairs stringified fields required to be objects", async () => {
    const input = {
      event: JSON.stringify({
        title: "iPhone momentum",
        type: "news",
        body: JSON.stringify({ mustStay: "string" }),
      }),
      annotation: JSON.stringify({ label: "Momentum" }),
      review: JSON.stringify({ confidence: "high" }),
    };
    const schema = {
      type: "object",
      properties: {
        event: {
          type: "object",
          properties: {
            title: { type: "string" },
            type: { type: "string", enum: ["news", "generic"] },
            body: { type: "string" },
          },
          required: ["title", "type"],
        },
        annotation: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        },
        review: {
          type: "object",
          properties: {
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
          },
          required: ["confidence"],
        },
      },
      required: ["event", "annotation", "review"],
    } satisfies JSONSchema7;
    const failed = repairFailure(
      {
        annotate: tool({
          inputSchema: jsonSchema(schema),
        }),
      },
      "annotate",
      JSON.stringify(input),
      schema,
    );

    expect(await repairToolCall(failed.tools, failed)).toEqual({
      ...failed.toolCall,
      input: JSON.stringify({
        event: {
          title: "iPhone momentum",
          type: "news",
          body: JSON.stringify({ mustStay: "string" }),
        },
        annotation: { label: "Momentum" },
        review: { confidence: "high" },
      }),
    });
  });

  test("does not coerce an invalid enum string", async () => {
    const failed = repairFailure(
      tools,
      "watchlist_semantic_result",
      JSON.stringify({ summary: "market_data" }),
      {
        type: "object",
        properties: { summary: { type: "string", enum: ["news", "generic"] } },
      },
    );

    expect(await repairToolCall(tools, failed)).toBeNull();
  });

  test.each([
    ["ordinary object input", JSON.stringify({ summary: "NVDA result" })],
    ["plain string input", JSON.stringify("not an object")],
    ["double-encoded number input", JSON.stringify("42")],
    ["double-encoded null input", JSON.stringify("null")],
    ["double-encoded array input", JSON.stringify(JSON.stringify([1, 2]))],
    [
      "triple-encoded object input",
      JSON.stringify(
        JSON.stringify(JSON.stringify({ summary: "NVDA result" })),
      ),
    ],
  ])("does not repair %s", async (_name, input) => {
    const failed = repairFailure(tools, "watchlist_semantic_result", input);

    expect(await repairToolCall(tools, failed)).toBeNull();
    expect(failed.error).toBeInstanceOf(InvalidToolInputError);
  });

  test("does not repair input for an unavailable tool", async () => {
    const inner = JSON.stringify({ summary: "NVDA result" });
    const failed = repairFailure(
      tools,
      "missing_semantic_result",
      JSON.stringify(inner),
    );

    expect(await repairToolCall(tools, failed)).toBeNull();
  });

  test("returns null when no deterministic repair applies", async () => {
    const failed = repairFailure(tools, "watchlist_semantic_result");

    expect(await repairToolCall(tools, failed)).toBeNull();
    expect(failed.error).toBeInstanceOf(InvalidToolInputError);
  });

  test("rejects with the original schema lookup failure", async () => {
    const failed = repairFailure(tools, "watchlist_semantic_result");
    const cause = new Error("Schema lookup failed");
    failed.inputSchema = async () => {
      throw cause;
    };

    await expect(repairToolCall(tools, failed)).rejects.toBe(cause);
  });
});
