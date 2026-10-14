// Purpose: Owns deterministic, re-validatable repairs for model-emitted tool calls.

import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider";
import type { Tool, ToolCallRepairFunction, ToolSet } from "ai";
import { JSONRepairError, jsonrepair } from "jsonrepair";
import { ToolInput } from "@openchart/server/agent/contracts/part";
import { Schema, Option } from "effect";

const MAX_REPAIR_DEPTH = 32;
const MAX_REPAIRED_OBJECT_STRINGS = 64;
const MAX_REPAIR_INPUT_LENGTH = 1_000_000;

type RepairState = {
  changed: boolean;
  repairedObjectStrings: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaObject(
  schema: JSONSchema7Definition | undefined,
): schema is JSONSchema7 {
  return typeof schema === "object" && schema !== null;
}

function parseJsonWithSyntaxRepair(input: string) {
  if (input.length > MAX_REPAIR_INPUT_LENGTH) return null;
  const decode = Schema.decodeUnknownOption(
    Schema.fromJsonString(Schema.Unknown),
  );
  const parsed = decode(input);
  if (Option.isSome(parsed))
    return { value: parsed.value, syntaxRepaired: false };

  try {
    const repaired = decode(jsonrepair(input));
    return Option.isSome(repaired)
      ? { value: repaired.value, syntaxRepaired: true }
      : null;
  } catch (cause) {
    if (cause instanceof JSONRepairError) return null;
    throw cause;
  }
}

function repairValueAgainstSchema(
  value: unknown,
  schema: JSONSchema7Definition | undefined,
  state: RepairState,
  depth: number,
): unknown {
  if (depth > MAX_REPAIR_DEPTH || !isSchemaObject(schema)) return value;

  if (schema.type === "object") {
    let objectValue = value;
    if (
      typeof objectValue === "string" &&
      state.repairedObjectStrings < MAX_REPAIRED_OBJECT_STRINGS
    ) {
      const parsed = parseJsonWithSyntaxRepair(objectValue);
      if (parsed && isRecord(parsed.value)) {
        objectValue = parsed.value;
        state.changed = true;
        state.repairedObjectStrings += 1;
      }
    }

    if (!isRecord(objectValue)) return objectValue;
    let result = objectValue;
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(objectValue, key)) continue;
      const current = objectValue[key];
      const repaired = repairValueAgainstSchema(
        current,
        childSchema,
        state,
        depth + 1,
      );
      if (repaired === current) continue;
      if (result === objectValue) result = { ...objectValue };
      result[key] = repaired;
    }
    return result;
  }

  const itemSchema = Array.isArray(schema.items) ? undefined : schema.items;
  if (
    schema.type === "array" &&
    Array.isArray(value) &&
    isSchemaObject(itemSchema)
  ) {
    let result = value;
    for (const [index, current] of value.entries()) {
      const repaired = repairValueAgainstSchema(
        current,
        itemSchema,
        state,
        depth + 1,
      );
      if (repaired === current) continue;
      if (result === value) result = [...value];
      result[index] = repaired;
    }
    return result;
  }

  return value;
}

function repairToolInput(input: string, schema: JSONSchema7) {
  const parsed = parseJsonWithSyntaxRepair(input);
  if (!parsed) return null;

  const state: RepairState = {
    changed: parsed.syntaxRepaired,
    repairedObjectStrings: 0,
  };
  const repaired = repairValueAgainstSchema(parsed.value, schema, state, 0);
  if (!state.changed) return null;

  const toolInput = Schema.decodeUnknownOption(ToolInput)(repaired);
  return Option.isSome(toolInput) ? JSON.stringify(toolInput.value) : null;
}

/**
 * Repairs only deterministic tool names and JSON encodings; the SDK must
 * validate the repaired input against the selected tool before execution.
 * Returns null when no repair applies; unexpected failures reject the SDK callback.
 *
 * @example
 * ```ts
 * experimental_repairToolCall: failed => repairToolCall(tools, failed)
 * ```
 */
export async function repairToolCall(
  tools: Record<string, Tool>,
  failed: Parameters<ToolCallRepairFunction<ToolSet>>[0],
) {
  const originalName = failed.toolCall.toolName;
  let toolName = originalName;
  if (!tools[toolName]) {
    const lower = toolName.toLowerCase();
    if (lower === toolName || !tools[lower]) return null;
    toolName = lower;
  }

  const repairedInput = repairToolInput(
    failed.toolCall.input,
    await failed.inputSchema({ toolName }),
  );
  if (toolName === originalName && repairedInput === null) return null;

  return {
    ...failed.toolCall,
    toolName,
    ...(repairedInput === null ? {} : { input: repairedInput }),
  };
}
