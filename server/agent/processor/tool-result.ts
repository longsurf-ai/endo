// Purpose: Projects observed and first-party tool outcomes into transcript values.

import type { ToolPart } from "@openchart/server/agent/contracts/part";
import { ascending } from "@openchart/identifier";
import { isObservedProviderTool } from "@openchart/models/provider-protocol";
import type { LLM } from "@openchart/server/agent/llm/llm";
import type { Tool } from "@openchart/server/agent/tool/tool";
import { assertTrue } from "@openchart/utils/assert";
import { Schema } from "effect";

/**
 * Projects the result according to execution provenance, never the tool name.
 * First-party evidence must already be materialized by the executing host.
 * Attachment identities belong to this transcript's tool result.
 * @example
 * const result = toolResult(event, runningPart);
 */
export function toolResult(
  event: Extract<LLM.SuccessStreamEvent, { type: "tool-result" }>,
  part: ToolPart,
) {
  if (isObservedProviderTool(event)) {
    const { output, attachments, computerUse } = event.output;
    return {
      title: event.toolName,
      metadata: {
        ...event.providerMetadata,
        ...(computerUse ? { computerUse } : {}),
      },
      output:
        typeof output === "string"
          ? { type: "text" as const, value: output }
          : { type: "json" as const, value: output },
      attachments: attachments.length
        ? attachments.map((file) => ({
            ...file,
            type: "file" as const,
            id: `prt_${ascending()}`,
            messageID: part.messageID,
          }))
        : undefined,
    };
  }
  // LLM preserves the typed execution result across the SDK's opaque output.
  const result = event.output;
  assertTrue(
    result.evidence === undefined,
    "Tool result contains unmaterialized evidence",
  );
  return {
    title: result.title,
    metadata: { ...part.state.metadata, ...result.metadata },
    output: result.output,
    attachments: result.attachments?.map((file) => ({
      ...file,
      id: `prt_${ascending()}`,
      messageID: part.messageID,
    })),
  };
}

/**
 * Extracts optional JSON progress details from a tool failure.
 * @example
 * const metadata = toolErrorMetadata(error);
 */
export function toolErrorMetadata(error: unknown): Tool.Metadata | undefined {
  if (error === null || typeof error !== "object" || !("metadata" in error))
    return undefined;
  return Schema.is(Schema.JsonObject)(error.metadata)
    ? error.metadata
    : undefined;
}

/**
 * Retains a readable failure message without parsing provider prose.
 * @example
 * const message = toolErrorMessage(error);
 */
export function toolErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message || String(error)
    : typeof error === "string"
      ? error
      : "Tool execution failed";
}
